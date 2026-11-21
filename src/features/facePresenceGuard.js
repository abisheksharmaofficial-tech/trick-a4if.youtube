import * as faceApiModule from "@vladmandic/face-api";

const DEFAULT_DETECTOR_OPTIONS = Object.freeze({
  inputSize: 320,
  scoreThreshold: 0.5,
});
const DEFAULT_PRESENCE_DEBOUNCE_MS = 400;
const DEFAULT_AWAY_THRESHOLD_MS = 2500;
const DEFAULT_FRAME_INTERVAL_MS = 250;

function resolveFaceApi(candidate) {
  try {
    const api = candidate ?? faceApiModule.default ?? faceApiModule;
    return api && typeof api.detectAllFaces === "function" && api.nets?.tinyFaceDetector
      ? api
      : null;
  } catch {
    return null;
  }
}

function normalizeDuration(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

function isVideoUsable(video) {
  try {
    return Boolean(video
      && typeof video === "object"
      && Number(video.videoWidth) > 0
      && Number(video.videoHeight) > 0
      && Number(video.readyState) >= 2);
  } catch {
    return false;
  }
}

/**
 * Detect whether a face is currently visible in a caller-provided video element.
 * Detection is performed locally through face-api; this class does not request
 * camera access, capture frames, or transmit video. The caller owns the stream.
 */
export class FacePresenceGuard {
  constructor(options = {}) {
    const settings = options && typeof options === "object" ? options : {};
    this.video = settings.videoElement ?? settings.video ?? null;
    this.modelUrl = typeof settings.modelUrl === "string" ? settings.modelUrl.trim() : "";
    this.faceApi = resolveFaceApi(settings.faceapi ?? settings.faceApi);
    this.detectorOptions = Object.freeze({
      ...DEFAULT_DETECTOR_OPTIONS,
      ...(settings.detectorOptions && typeof settings.detectorOptions === "object"
        ? settings.detectorOptions
        : {}),
    });
    this.presenceDebounceMs = normalizeDuration(
      settings.presenceDebounceMs ?? settings.debounceMs,
      DEFAULT_PRESENCE_DEBOUNCE_MS,
    );
    this.awayThresholdMs = normalizeDuration(settings.awayThresholdMs, DEFAULT_AWAY_THRESHOLD_MS);
    this.frameIntervalMs = normalizeDuration(settings.frameIntervalMs, DEFAULT_FRAME_INTERVAL_MS, 16);
    this.onStateChange = typeof settings.onStateChange === "function" ? settings.onStateChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;

    this.state = "unknown";
    this.isRunning = false;
    this.isDestroyed = false;
    this.modelsReady = false;
    this.lastFaceCount = 0;
    this.lastEvaluatedAt = null;
    this.lastError = null;

    this._modelLoadPromise = null;
    this._timerId = null;
    this._frameRequestId = null;
    this._frameCallbackMode = false;
    this._evaluationInProgress = false;
    this._absenceStartedAt = null;
    this._presenceStartedAt = null;
    this._boundFrame = () => { void this._runFrame(); };
  }

  /** Load the tiny face detector once; modelUrl must point at hosted model files. */
  async loadModels() {
    try {
      if (this.isDestroyed || !this.faceApi || !this.modelUrl) return false;
      if (this.modelsReady) return true;
      if (this._modelLoadPromise) return await this._modelLoadPromise;

      const net = this.faceApi.nets.tinyFaceDetector;
      if (!net || typeof net.loadFromUri !== "function") return false;
      if (net.isLoaded === true) {
        this.modelsReady = true;
        return true;
      }

      this._modelLoadPromise = Promise.resolve(net.loadFromUri(this.modelUrl))
        .then(() => {
          if (this.isDestroyed) return false;
          this.modelsReady = true;
          return true;
        })
        .catch((error) => {
          this._reportError(error);
          return false;
        })
        .finally(() => {
          this._modelLoadPromise = null;
        });
      return await this._modelLoadPromise;
    } catch (error) {
      this._reportError(error);
      this._modelLoadPromise = null;
      return false;
    }
  }

  /**
   * Evaluate one ready video frame and update debounced presence state.
   * Returns null on unavailable video, models, or detector errors.
   */
  async evaluateFrame(now = Date.now()) {
    try {
      if (this.isDestroyed || !this.faceApi || !isVideoUsable(this.video)) return null;
      const timestamp = Number(now);
      if (!Number.isFinite(timestamp)) return null;
      if (!await this.loadModels()) return null;

      const detectorOptions = typeof this.faceApi.TinyFaceDetectorOptions === "function"
        ? new this.faceApi.TinyFaceDetectorOptions(this.detectorOptions)
        : this.detectorOptions;
      const detections = await this.faceApi.detectAllFaces(this.video, detectorOptions);
      if (!Array.isArray(detections)) return null;

      const faceCount = detections.length;
      this.lastFaceCount = faceCount;
      this.lastEvaluatedAt = timestamp;
      this._updatePresenceState(faceCount > 0, timestamp);
      return Object.freeze({
        faceCount,
        present: faceCount > 0,
        state: this.state,
        evaluatedAt: timestamp,
      });
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Start model loading and the periodic frame-evaluation loop. */
  async start(video = this.video) {
    try {
      if (this.isDestroyed || !video || typeof video !== "object") return false;
      this.video = video;
      if (!this.faceApi || !this.modelUrl || !await this.loadModels()) return false;
      if (this.isDestroyed) return false;
      if (this.isRunning) return true;

      this.isRunning = true;
      this._scheduleNextFrame();
      return true;
    } catch (error) {
      this._reportError(error);
      this.isRunning = false;
      return false;
    }
  }

  /** Stop frame evaluation without stopping or releasing the caller's video stream. */
  stop() {
    try {
      this.isRunning = false;
      if (this._frameCallbackMode && this._frameRequestId !== null
        && typeof this.video?.cancelVideoFrameCallback === "function") {
        this.video.cancelVideoFrameCallback(this._frameRequestId);
      }
      if (this._timerId !== null) clearTimeout(this._timerId);
      this._frameRequestId = null;
      this._timerId = null;
      this._frameCallbackMode = false;
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Stop evaluation and release this guard's internal references. */
  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.stop();
      this.isDestroyed = true;
      this._absenceStartedAt = null;
      this._presenceStartedAt = null;
      this.video = null;
      this.faceApi = null;
      this.onStateChange = null;
      this.onError = null;
      this._boundFrame = null;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }

  _updatePresenceState(present, now) {
    try {
      if (present) {
        this._absenceStartedAt = null;
        if (this.state === "present") {
          this._presenceStartedAt = null;
          return;
        }
        if (this._presenceStartedAt === null) this._presenceStartedAt = now;
        if (now - this._presenceStartedAt >= this.presenceDebounceMs) {
          this._setState("present", now);
          this._presenceStartedAt = null;
        }
        return;
      }

      this._presenceStartedAt = null;
      if (this.state === "away") {
        this._absenceStartedAt = null;
        return;
      }
      if (this._absenceStartedAt === null) this._absenceStartedAt = now;
      if (now - this._absenceStartedAt >= this.awayThresholdMs) {
        this._setState("away", now);
        this._absenceStartedAt = null;
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _setState(nextState, now) {
    try {
      if (this.state === nextState) return;
      const previousState = this.state;
      this.state = nextState;
      if (this.onStateChange) {
        this.onStateChange(Object.freeze({
          state: nextState,
          previousState,
          present: nextState === "present",
          faceCount: this.lastFaceCount,
          changedAt: now,
        }));
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _scheduleNextFrame() {
    try {
      if (!this.isRunning || this.isDestroyed || !this.video) return;
      if (typeof this.video.requestVideoFrameCallback === "function") {
        this._frameCallbackMode = true;
        this._frameRequestId = this.video.requestVideoFrameCallback(this._boundFrame);
      } else {
        this._frameCallbackMode = false;
        this._timerId = setTimeout(this._boundFrame, this.frameIntervalMs);
      }
    } catch (error) {
      this._reportError(error);
      this.stop();
    }
  }

  async _runFrame() {
    try {
      this._frameRequestId = null;
      this._timerId = null;
      if (!this.isRunning || this.isDestroyed) return;
      if (!this._evaluationInProgress) {
        this._evaluationInProgress = true;
        try {
          await this.evaluateFrame();
        } finally {
          this._evaluationInProgress = false;
        }
      }
      this._scheduleNextFrame();
    } catch (error) {
      this._reportError(error);
      this._evaluationInProgress = false;
      this._scheduleNextFrame();
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Face presence evaluation failed.");
      if (this.onError) this.onError(this.lastError);
    } catch {
      // Error reporting must never interrupt the video processing lifecycle.
    }
  }
}

/** Create a face-presence guard without throwing when browser APIs are unavailable. */
export function createFacePresenceGuard(options = {}) {
  try {
    return new FacePresenceGuard(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  FacePresenceGuard,
  createFacePresenceGuard,
});
