/**
 * Touchless air-gesture detector for video/canvas input.
 *
 * This implementation uses motion in a local browser frame stream and does not
 * claim hand-pose or object-detection capabilities. It detects horizontal/
 * vertical motion swipes and sustained wave-like movement, without transmitting
 * or recording frames.
 */

export class GestureAirControl {
  constructor(options = {}) {
    const settings =
      options && typeof options === "object" && !Array.isArray(options)
        ? options
        : {};

    this.video = settings.video ?? settings.videoElement ?? null;
    this.canvas =
      settings.canvas ??
      (typeof document !== "undefined"
        ? document.createElement("canvas")
        : null);
    this.context =
      this.canvas && typeof this.canvas.getContext === "function"
        ? this.canvas.getContext("2d", { willReadFrequently: true })
        : null;

    this.width = this._validInteger(settings.width, 160, 16, 1280);
    this.height = this._validInteger(settings.height, 90, 16, 720);
    this.frameIntervalMs = this._validNumber(
      settings.frameIntervalMs,
      50,
      16,
      1000,
    );
    this.pixelStep = this._validInteger(settings.pixelStep, 8, 2, 64);
    this.motionThreshold = this._validNumber(
      settings.motionThreshold,
      22,
      1,
      255,
    );
    this.minimumMotionPixels = this._validInteger(
      settings.minimumMotionPixels,
      40,
      1,
      100000,
    );
    this.swipePixels = this._validNumber(
      settings.swipePixels,
      15,
      1,
      1000,
    );
    this.swipeMinimumRatio = this._validNumber(
      settings.swipeMinimumRatio,
      1.35,
      1,
      10,
    );
    this.waveCycles = this._validInteger(settings.waveCycles, 2, 1, 20);
    this.waveMinimumPixels = this._validNumber(
      settings.waveMinimumPixels,
      12,
      1,
      1000,
    );
    this.debounceMs = this._validNumber(
      settings.debounceMs,
      350,
      0,
      10000,
    );
    this.cooldownMs = this._validNumber(
      settings.cooldownMs,
      700,
      0,
      30000,
    );
    this.toggleCooldownMs = this._validNumber(
      settings.toggleCooldownMs,
      900,
      0,
      30000,
    );

    this.onGesture =
      typeof settings.onGesture === "function" ? settings.onGesture : null;
    this.onError =
      typeof settings.onError === "function" ? settings.onError : null;

    this.isRunning = false;
    this.isDestroyed = false;
    this.lastError = null;
    this.lastGesture = null;
    this.lastGestureAt = 0;

    this._timerId = null;
    this._frameRequestId = null;
    this._frameCallbackMode = false;
    this._processing = false;
    this._previousFrame = null;
    this._previousMotionCenter = null;
    this._horizontalMotion = 0;
    this._verticalMotion = 0;
    this._horizontalDirectionChanges = 0;
    this._lastHorizontalDirection = 0;
    this._candidateDirection = 0;
    this._candidateStart = null;
    this._lastWaveDirection = 0;
    this._lastCandidateGestureAt = 0;
    this._lastToggleAt = 0;
    this._boundFrame = () => this._runFrame();
  }

  async start(video = this.video) {
    try {
      if (this.isDestroyed) return false;
      if (!video || typeof video !== "object") return false;

      this.video = video;
      if (typeof this.canvas?.getContext !== "function") return false;
      if (!this.context) {
        this.context = this.canvas.getContext("2d", {
          willReadFrequently: true,
        });
      }
      if (!this.context) return false;

      if (this.canvas.width !== this.width) this.canvas.width = this.width;
      if (this.canvas.height !== this.height) this.canvas.height = this.height;

      if (this.isRunning) return true;
      this.isRunning = true;
      this._resetTracking();
      this._scheduleNextFrame();
      return true;
    } catch (error) {
      this._reportError(error);
      this.isRunning = false;
      return false;
    }
  }

  stop() {
    try {
      this.isRunning = false;

      if (
        this._frameCallbackMode &&
        this._frameRequestId !== null &&
        typeof this.video?.cancelVideoFrameCallback === "function"
      ) {
        this.video.cancelVideoFrameCallback(this._frameRequestId);
      }

      if (this._timerId !== null) {
        clearTimeout(this._timerId);
      }

      this._frameRequestId = null;
      this._timerId = null;
      this._frameCallbackMode = false;
      this._processing = false;
      this._previousFrame = null;
      this._resetTracking();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.stop();
      this._previousFrame = null;
      this._boundFrame = null;
      this.video = null;
      this.canvas = null;
      this.context = null;
      this.onGesture = null;
      this.onError = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }

  /**
   * Process one video frame. The result is null if video or canvas state is
   * unavailable, the frame is not ready, or processing fails.
   */
  async processFrame(now = Date.now()) {
    try {
      if (this.isDestroyed || !this.isRunning) return null;
      if (!isVideoReady(this.video) || !this.context) return null;

      const timestamp = this._validTimestamp(now);
      if (timestamp === null) return null;

      this.context.drawImage(
        this.video,
        0,
        0,
        this.width,
        this.height,
      );

      const frame = this.context.getImageData(
        0,
        0,
        this.width,
        this.height,
      );

      if (
        !frame ||
        !frame.data ||
        frame.width !== this.width ||
        frame.height !== this.height
      ) {
        return null;
      }

      if (!this._previousFrame) {
        this._previousFrame = new Uint8ClampedArray(frame.data);
        return Object.freeze({
          gesture: null,
          motionPixels: 0,
          timestamp,
        });
      }

      const analysis = analyzeFrameDifference(
        this._previousFrame,
        frame.data,
        this.width,
        this.height,
        this.pixelStep,
        this.motionThreshold,
      );

      this._previousFrame = new Uint8ClampedArray(frame.data);

      if (analysis.motionPixels < this.minimumMotionPixels) {
        this._candidateDirection = 0;
        this._candidateStart = null;
        this._previousMotionCenter = null;
        return Object.freeze({
          gesture: null,
          motionPixels: analysis.motionPixels,
          timestamp,
        });
      }

      this._horizontalMotion += analysis.horizontalMotion;
      this._verticalMotion += analysis.verticalMotion;

      this._trackMovementCenter(analysis.motionCenterX, timestamp);
      const swipe = this._detectSwipe(timestamp);
      if (swipe) {
        this._emitGesture(swipe, timestamp);
        return Object.freeze({
          gesture: swipe,
          motionPixels: analysis.motionPixels,
          timestamp,
        });
      }

      const wave = this._detectWave(timestamp);
      if (wave) {
        this._emitGesture(wave, timestamp);
        return Object.freeze({
          gesture: wave,
          motionPixels: analysis.motionPixels,
          timestamp,
        });
      }

      return Object.freeze({
        gesture: null,
        motionPixels: analysis.motionPixels,
        timestamp,
      });
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _trackMovementCenter(centerX, timestamp) {
    try {
      if (!Number.isFinite(centerX)) {
        this._previousMotionCenter = null;
        return;
      }

      if (this._previousMotionCenter === null) {
        this._previousMotionCenter = centerX;
        return;
      }

      const movement = centerX - this._previousMotionCenter;
      this._previousMotionCenter = centerX;

      if (Math.abs(movement) < 0.5) return;

      const direction = movement > 0 ? 1 : -1;
      if (this._candidateStart === null) {
        this._candidateStart = {
          x: centerX,
          direction,
          timestamp,
        };
      }

      if (direction !== this._candidateDirection) {
        this._candidateDirection = direction;
        if (this._lastHorizontalDirection !== 0 &&
            direction !== this._lastHorizontalDirection) {
          this._horizontalDirectionChanges += 1;
        }
        this._lastHorizontalDirection = direction;
      }

      if (Math.abs(this._horizontalMotion) >= this.swipePixels) {
        this._candidateDirection = direction;
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _detectSwipe(timestamp) {
    try {
      const horizontal = this._horizontalMotion;
      const vertical = this._verticalMotion;

      if (
        Math.abs(horizontal) < this.swipePixels ||
        Math.abs(horizontal) <
          Math.abs(vertical) * this.swipeMinimumRatio
      ) {
        return null;
      }

      const action = horizontal > 0 ? "swipeRight" : "swipeLeft";

      if (!this._passesDebounceAndCooldown(action, timestamp)) return null;

      this._resetTracking();
      return action;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _detectWave(timestamp) {
    try {
      if (this._horizontalDirectionChanges < this.waveCycles * 2) return null;

      const horizontalMagnitude = Math.abs(this._horizontalMotion);
      if (horizontalMagnitude < this.waveMinimumPixels) return null;

      const direction =
        this._candidateDirection !== 0
          ? this._candidateDirection
          : this._lastHorizontalDirection;

      if (direction === 0) return null;

      const action =
        direction > 0 ? "waveRight" : "waveLeft";

      if (!this._passesDebounceAndCooldown(action, timestamp)) return null;

      this._resetTracking();
      this._lastWaveDirection = direction;
      return action;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _passesDebounceAndCooldown(action, timestamp) {
    try {
      if (
        timestamp - this.lastGestureAt < this.cooldownMs &&
        action === this.lastGesture
      ) {
        return false;
      }

      if (
        timestamp - this._lastCandidateGestureAt < this.debounceMs &&
        action === this.lastGesture
      ) {
        return false;
      }

      if (
        action === "toggle" &&
        timestamp - this._lastToggleAt < this.toggleCooldownMs
      ) {
        return false;
      }

      this._lastCandidateGestureAt = timestamp;
      return true;
    } catch {
      return false;
    }
  }

  detectToggle(timestamp = Date.now()) {
    try {
      if (this.isDestroyed) return null;
      const now = this._validTimestamp(timestamp);
      if (now === null) return null;
      if (!this._passesDebounceAndCooldown("toggle", now)) return null;
      this._lastToggleAt = now;
      this._emitGesture("toggle", now);
      return "toggle";
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _emitGesture(gesture, timestamp) {
    try {
      this.lastGesture = gesture;
      this.lastGestureAt = timestamp;

      if (this.onGesture) {
        this.onGesture(
          Object.freeze({
            gesture,
            timestamp,
            faceCount: null,
          }),
        );
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
        this._frameRequestId =
          this.video.requestVideoFrameCallback(this._boundFrame);
        return;
      }

      this._frameCallbackMode = false;
      this._timerId = setTimeout(
        this._boundFrame,
        this.frameIntervalMs,
      );
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

      if (!this._processing) {
        this._processing = true;
        try {
          await this.processFrame();
        } finally {
          this._processing = false;
        }
      }

      this._scheduleNextFrame();
    } catch (error) {
      this._reportError(error);
      this._processing = false;
      this._scheduleNextFrame();
    }
  }

  _resetTracking() {
    this._previousMotionCenter = null;
    this._horizontalMotion = 0;
    this._verticalMotion = 0;
    this._horizontalDirectionChanges = 0;
    this._lastHorizontalDirection = 0;
    this._candidateDirection = 0;
    this._candidateStart = null;
  }

  _validTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  _validNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, number))
      : fallback;
  }

  _validInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.trunc(Math.min(maximum, Math.max(minimum, number)))
      : fallback;
  }

  _reportError(error) {
    try {
      this.lastError =
        error instanceof Error
          ? error
          : new Error("Gesture frame processing failed.");
      if (this.onError) this.onError(this.lastError);
    } catch {
      // Error reporting must never interrupt the gesture lifecycle.
    }
  }
}

function isVideoReady(video) {
  try {
    return Boolean(
      video &&
        typeof video === "object" &&
        Number(video.readyState) >= 2 &&
        Number(video.videoWidth) > 0 &&
        Number(video.videoHeight) > 0,
    );
  } catch {
    return false;
  }
}

function analyzeFrameDifference(
  previous,
  current,
  width,
  height,
  pixelStep,
  threshold,
) {
  let motionPixels = 0;
  let leftMotion = 0;
  let rightMotion = 0;
  let upMotion = 0;
  let downMotion = 0;
  let weightedX = 0;
  let weightedMotion = 0;

  for (let y = 0; y < height; y += pixelStep) {
    for (let x = 0; x < width; x += pixelStep) {
      const index = (y * width + x) * 4;
      const previousLuminosity =
        previous[index] * 0.299 +
        previous[index + 1] * 0.587 +
        previous[index + 2] * 0.114;
      const currentLuminosity =
        current[index] * 0.299 +
        current[index + 1] * 0.587 +
        current[index + 2] * 0.114;
      const difference = Math.abs(
        currentLuminosity - previousLuminosity,
      );

      if (difference < threshold) continue;

      motionPixels += 1;
      weightedX += x * difference;
      weightedMotion += difference;

      if (x < width * 0.5) leftMotion += difference;
      else rightMotion += difference;
      if (y < height * 0.5) upMotion += difference;
      else downMotion += difference;
    }
  }

  const horizontalBalance = rightMotion - leftMotion;
  const verticalBalance = downMotion - upMotion;

  return {
    motionPixels,
    horizontalMotion: horizontalBalance / 255,
    verticalMotion: verticalBalance / 255,
    motionCenterX:
      weightedMotion > 0 ? weightedX / weightedMotion : 0,
  };
}

export function createGestureAirControl(options = {}) {
  try {
    return new GestureAirControl(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  GestureAirControl,
  createGestureAirControl,
});
