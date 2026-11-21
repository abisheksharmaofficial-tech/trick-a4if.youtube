const DEFAULT_PRESETS = Object.freeze({
  5: 5 * 60,
  10: 10 * 60,
  15: 15 * 60,
  30: 30 * 60,
  45: 45 * 60,
  60: 60 * 60,
});
const DEFAULT_TICK_INTERVAL_MS = 1000;

function normalizeSeconds(value, fallback = 0) {
  try {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : fallback;
  } catch {
    return fallback;
  }
}

function normalizePresets(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_PRESETS };
    const presets = {};
    for (const [name, seconds] of Object.entries(value)) {
      const normalized = normalizeSeconds(seconds, -1);
      if (normalized > 0) presets[String(name).toLocaleLowerCase()] = normalized;
    }
    return Object.keys(presets).length ? presets : { ...DEFAULT_PRESETS };
  } catch {
    return { ...DEFAULT_PRESETS };
  }
}

/**
 * A lifecycle-safe sleep timer. Durations passed to this class and its methods
 * are seconds; preset values are also expressed in seconds. When
 * endOfCurrentVideo is enabled, reaching zero waits for the current video to
 * finish before invoking the expiry callback.
 */
export class SmartSleepTimer {
  constructor(options = {}) {
    const settings = options && typeof options === "object" ? options : {};
    this.presets = Object.freeze(normalizePresets(settings.presets));
    this.tickIntervalMs = Math.max(50, normalizeSeconds(settings.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS));
    this.endOfCurrentVideo = Boolean(settings.endOfCurrentVideo ?? settings.completeCurrentVideo);
    this.videoElement = settings.videoElement ?? settings.video ?? null;
    this.onTick = typeof settings.onTick === "function" ? settings.onTick : null;
    this.onExpire = typeof settings.onExpire === "function"
      ? settings.onExpire
      : (typeof settings.onExpired === "function" ? settings.onExpired : null);
    this.onError = typeof settings.onError === "function" ? settings.onError : null;

    this.state = "idle";
    this.durationSeconds = 0;
    this.remainingSeconds = 0;
    this.lastError = null;
    this._deadline = null;
    this._intervalId = null;
    this._videoEnded = false;
    this._listeningToVideo = false;
    this._handleVideoEnded = () => this._onVideoEnded();

    try {
      if (settings.preset !== undefined) this.setPreset(settings.preset);
      else if (settings.durationSeconds !== undefined) this.setDuration(settings.durationSeconds);
      else if (settings.durationMinutes !== undefined) this.setDuration(normalizeSeconds(settings.durationMinutes) * 60);
    } catch (error) {
      this._reportError(error);
    }
  }

  /** Set the timer duration in seconds without starting it. */
  setDuration(seconds) {
    try {
      if (this.state === "running" || this.state === "paused" || this.state === "waiting-for-video") return false;
      const duration = normalizeSeconds(seconds, -1);
      if (duration < 0) return false;
      this.durationSeconds = duration;
      this.remainingSeconds = duration;
      this.state = "idle";
      this._emitTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Select a configured preset (preset values are seconds). */
  setPreset(preset) {
    try {
      const key = String(preset).toLocaleLowerCase();
      if (!Object.prototype.hasOwnProperty.call(this.presets, key)) return false;
      return this.setDuration(this.presets[key]);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Start or restart the countdown. An optional argument is seconds or a preset name. */
  start(durationOrPreset) {
    try {
      if (this.state === "destroyed") return false;
      if (durationOrPreset !== undefined) {
        const selected = typeof durationOrPreset === "string"
          ? this.setPreset(durationOrPreset)
          : this.setDuration(durationOrPreset);
        if (!selected) return false;
      }
      if (!(this.durationSeconds > 0)) return false;

      this._stopInterval();
      this._removeVideoListener();
      this.remainingSeconds = this.durationSeconds;
      this._videoEnded = false;
      this._deadline = Date.now() + this.remainingSeconds * 1000;
      this.state = "running";
      this._attachVideoListener();
      this._emitTick();
      this._scheduleTick();
      return true;
    } catch (error) {
      this._reportError(error);
      this._stopInterval();
      this.state = "idle";
      return false;
    }
  }

  /** Pause while preserving the exact remaining duration. */
  pause() {
    try {
      if (this.state !== "running" && this.state !== "waiting-for-video") return false;
      if (this.state === "running") this._refreshRemaining();
      this._stopInterval();
      this.state = "paused";
      this._emitTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Resume a paused countdown or a countdown waiting for the current video. */
  resume() {
    try {
      if (this.state !== "paused" || this.remainingSeconds <= 0) return false;
      this._deadline = Date.now() + this.remainingSeconds * 1000;
      this.state = "running";
      this._attachVideoListener();
      this._scheduleTick();
      this._emitTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Add seconds to the current countdown, including while paused. */
  extend(seconds) {
    try {
      const amount = normalizeSeconds(seconds, -1);
      if (amount <= 0 || this.state === "idle" || this.state === "cancelled" || this.state === "expired"
        || this.state === "destroyed") return false;
      this.remainingSeconds = this._currentRemaining() + amount;
      if (this.state === "running") this._deadline = Date.now() + this.remainingSeconds * 1000;
      if (this.state === "waiting-for-video") {
        this.state = "running";
        this._deadline = Date.now() + this.remainingSeconds * 1000;
        this._scheduleTick();
      }
      this.durationSeconds += amount;
      this._emitTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for extend(seconds). */
  addTime(seconds) {
    try {
      return this.extend(seconds);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Cancel and clear the active countdown. Use reset() to restore its duration. */
  cancel() {
    try {
      if (this.state === "destroyed") return false;
      this._stopInterval();
      this._removeVideoListener();
      this._deadline = null;
      this.remainingSeconds = 0;
      this._videoEnded = false;
      this.state = "cancelled";
      this._emitTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Return to idle with the configured duration restored. */
  reset() {
    try {
      if (this.state === "destroyed") return false;
      this._stopInterval();
      this._removeVideoListener();
      this._deadline = null;
      this.remainingSeconds = this.durationSeconds;
      this._videoEnded = false;
      this.state = "idle";
      this._emitTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Stop the timer and release its callbacks and element references. */
  destroy() {
    try {
      if (this.state === "destroyed") return true;
      this._stopInterval();
      this._removeVideoListener();
      this._deadline = null;
      this.state = "destroyed";
      this.videoElement = null;
      this.onTick = null;
      this.onExpire = null;
      this.onError = null;
      return true;
    } catch (error) {
      this._reportError(error);
      this.state = "destroyed";
      return false;
    }
  }

  /** Get an immutable snapshot of the current timer state. */
  getStatus() {
    try {
      const remaining = this.state === "running" ? this._currentRemaining() : this.remainingSeconds;
      return Object.freeze({
        state: this.state,
        durationSeconds: this.durationSeconds,
        remainingSeconds: Math.max(0, remaining),
        remainingWholeSeconds: Math.ceil(Math.max(0, remaining)),
        endOfCurrentVideo: this.endOfCurrentVideo,
      });
    } catch {
      return null;
    }
  }

  _scheduleTick() {
    try {
      if (this.state !== "running" || this._intervalId !== null) return;
      this._intervalId = setInterval(() => this._onTick(), this.tickIntervalMs);
      if (this._intervalId && typeof this._intervalId.unref === "function") this._intervalId.unref();
      this._onTick();
    } catch (error) {
      this._reportError(error);
      this._stopInterval();
    }
  }

  _onTick() {
    try {
      if (this.state !== "running") return;
      this._refreshRemaining();
      this._emitTick();
      if (this.remainingSeconds <= 0) this._reachZero();
    } catch (error) {
      this._reportError(error);
    }
  }

  _refreshRemaining() {
    try {
      if (this._deadline !== null) {
        this.remainingSeconds = Math.max(0, (this._deadline - Date.now()) / 1000);
      }
      return this.remainingSeconds;
    } catch {
      return this.remainingSeconds;
    }
  }

  _currentRemaining() {
    try {
      return this.state === "running" ? this._refreshRemaining() : this.remainingSeconds;
    } catch {
      return this.remainingSeconds;
    }
  }

  _reachZero() {
    try {
      this.remainingSeconds = 0;
      this._deadline = null;
      this._stopInterval();
      if (this.endOfCurrentVideo && this.videoElement && !this._videoEnded && !this._isVideoEnded()) {
        this.state = "waiting-for-video";
        this._emitTick();
        return;
      }
      this._expire();
    } catch (error) {
      this._reportError(error);
      this._expire();
    }
  }

  _expire() {
    try {
      if (this.state === "expired" || this.state === "destroyed" || this.state === "cancelled") return;
      this._stopInterval();
      this._removeVideoListener();
      this.remainingSeconds = 0;
      this._deadline = null;
      this.state = "expired";
      this._emitTick();
      const callback = this.onExpire;
      if (callback) {
        try {
          callback(this.getStatus());
        } catch (error) {
          this._reportError(error);
        }
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _onVideoEnded() {
    try {
      this._videoEnded = true;
      this._removeVideoListener();
      if (this.state === "waiting-for-video") this._expire();
    } catch (error) {
      this._reportError(error);
    }
  }

  _attachVideoListener() {
    try {
      const video = this.videoElement;
      if (!this.endOfCurrentVideo || !video || this._listeningToVideo
        || typeof video.addEventListener !== "function") return false;
      video.addEventListener("ended", this._handleVideoEnded, { once: true });
      this._listeningToVideo = true;
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _removeVideoListener() {
    try {
      if (this._listeningToVideo && this.videoElement
        && typeof this.videoElement.removeEventListener === "function") {
        this.videoElement.removeEventListener("ended", this._handleVideoEnded);
      }
      this._listeningToVideo = false;
      return true;
    } catch {
      this._listeningToVideo = false;
      return false;
    }
  }

  _isVideoEnded() {
    try {
      return Boolean(this.videoElement?.ended);
    } catch {
      return false;
    }
  }

  _emitTick() {
    try {
      if (!this.onTick || this.state === "destroyed") return;
      const remaining = this.state === "running" ? this._currentRemaining() : this.remainingSeconds;
      const snapshot = Object.freeze({
        state: this.state,
        durationSeconds: this.durationSeconds,
        remainingSeconds: Math.max(0, remaining),
        remainingWholeSeconds: Math.ceil(Math.max(0, remaining)),
      });
      try {
        this.onTick(snapshot);
      } catch (error) {
        this._reportError(error);
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _stopInterval() {
    try {
      if (this._intervalId !== null) clearInterval(this._intervalId);
      this._intervalId = null;
      return true;
    } catch {
      this._intervalId = null;
      return false;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Sleep timer operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt the timer lifecycle.
    }
  }
}

/** Create a sleep timer without throwing in unsupported environments. */
export function createSmartSleepTimer(options = {}) {
  try {
    return new SmartSleepTimer(options);
  } catch {
    return null;
  }
}

export const SMART_SLEEP_TIMER_PRESETS = DEFAULT_PRESETS;

export default Object.freeze({
  SMART_SLEEP_TIMER_PRESETS,
  SmartSleepTimer,
  createSmartSleepTimer,
});
