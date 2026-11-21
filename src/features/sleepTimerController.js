const STORAGE_KEY = "trick-a4if-tube:sleep-timer:v1";
const memoryStorage = new Map();
const DEFAULT_TICK_INTERVAL_MS = 1000;
const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;
const ACTIVE_STATES = new Set(["running", "paused", "waiting-for-video"]);

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

function normalizeNonNegative(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(MAX_DURATION_SECONDS, number) : fallback;
  } catch { return fallback; }
}

function normalizePositive(value, fallback) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeUnit(value, fallback = "seconds") {
  try {
    const unit = String(value ?? fallback).trim().toLowerCase();
    if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return "minutes";
    if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return "seconds";
    return fallback;
  } catch { return fallback; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function toSeconds(value, unit = "seconds") {
  try {
    const number = normalizeNonNegative(value, null);
    if (number === null) return null;
    const seconds = number * (normalizeUnit(unit) === "minutes" ? 60 : 1);
    return Number.isFinite(seconds) ? Math.min(MAX_DURATION_SECONDS, seconds) : null;
  } catch { return null; }
}

/**
 * Lifecycle-safe sleep timer. Duration values are seconds by default; pass
 * "minutes" as a unit or use startMinutes(). End-of-video mode listens to the
 * caller-provided video's ended event. No playback is simulated or initiated.
 */
export class SleepTimerController {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.tickIntervalMs = Math.max(50, normalizePositive(settings.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS));
      this.storage = resolveStorage(settings.storage);
      this.storageKey = typeof settings.storageKey === "string" && settings.storageKey.trim()
        ? settings.storageKey.trim().slice(0, 512) : STORAGE_KEY;
      this.videoElement = settings.videoElement ?? settings.video ?? null;
      this.onTick = typeof settings.onTick === "function" ? settings.onTick : null;
      this.onExpire = typeof settings.onExpire === "function" ? settings.onExpire
        : (typeof settings.onExpired === "function" ? settings.onExpired : null);
      this.onPause = typeof settings.onPause === "function" ? settings.onPause : null;
      this.onStop = typeof settings.onStop === "function" ? settings.onStop : null;
      this.onStateChange = typeof settings.onStateChange === "function" ? settings.onStateChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.state = "idle";
      this.mode = "duration";
      this.durationSeconds = 0;
      this.remainingSeconds = 0;
      this.isDestroyed = false;
      this._deadline = null;
      this._timerId = null;
      this._listeningToVideo = false;
      this._subscribers = new Set();
      this._handleVideoEnded = () => this._onVideoEnded();
      this._load();
      if (settings.autoStart === true && this.durationSeconds > 0 && this.state === "idle") this.start();
    } catch (error) {
      this._reportError(error);
      this.state = "idle";
      this.mode = "duration";
      this.durationSeconds = 0;
      this.remainingSeconds = 0;
      this.isDestroyed = false;
      this._deadline = null;
      this._timerId = null;
      this._listeningToVideo = false;
      this._subscribers = new Set();
    }
  }

  /** Start or restart a timer; duration is seconds unless unit is minutes. */
  start(duration, unit = "seconds") {
    try {
      if (this.isDestroyed) return false;
      if (isRecord(duration)) {
        const settings = duration;
        if (settings.mode === "endOfVideo" || settings.mode === "end-of-video" || settings.endOfVideo === true) {
          return this.startEndOfVideo(settings.videoElement ?? settings.video ?? this.videoElement);
        }
        unit = settings.unit ?? settings.units ?? unit;
        duration = settings.duration ?? settings.durationSeconds ?? settings.durationMinutes;
        if (settings.durationMinutes !== undefined && settings.duration === undefined && settings.durationSeconds === undefined) unit = "minutes";
      }
      if (duration !== undefined) {
        const seconds = toSeconds(duration, unit);
        if (seconds === null || seconds <= 0) return false;
        this.durationSeconds = seconds;
        this.remainingSeconds = seconds;
      }
      if (!(this.durationSeconds > 0)) return false;
      this._stopTimer();
      this._removeVideoListener();
      this.mode = "duration";
      this.remainingSeconds = this.durationSeconds;
      this._deadline = Date.now() + this.remainingSeconds * 1000;
      this.state = "running";
      this._persist();
      this._emitStateChange("start");
      this._emitTick("start");
      this._scheduleTick();
      return true;
    } catch (error) { this._reportError(error); this._stopTimer(); return false; }
  }

  startSeconds(seconds) { return this.start(seconds, "seconds"); }
  startMinutes(minutes) { return this.start(minutes, "minutes"); }

  /** Wait for the supplied media element to end, then expire the timer. */
  startEndOfVideo(videoElement = this.videoElement) {
    try {
      if (this.isDestroyed || !videoElement || typeof videoElement.addEventListener !== "function") return false;
      this._stopTimer();
      this._removeVideoListener();
      this.videoElement = videoElement;
      this.mode = "end-of-video";
      this.durationSeconds = 0;
      this.remainingSeconds = 0;
      this._deadline = null;
      this.state = "running";
      if (this._isVideoEnded()) {
        this._expire("video-ended");
        return true;
      }
      videoElement.addEventListener("ended", this._handleVideoEnded);
      this._listeningToVideo = true;
      this._persist();
      this._emitStateChange("start-end-of-video");
      this._emitTick("start-end-of-video");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  startAtEndOfVideo(videoElement) { return this.startEndOfVideo(videoElement); }

  pause() {
    try {
      if (this.isDestroyed || this.state !== "running") return false;
      if (this.mode === "duration") this._refreshRemaining();
      this._stopTimer();
      this._deadline = null;
      this._removeVideoListener();
      this.state = "paused";
      this._persist();
      this._emitStateChange("pause");
      this._emitTick("pause");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  resume() {
    try {
      if (this.isDestroyed || this.state !== "paused") return false;
      if (this.mode === "duration") {
        if (this.remainingSeconds <= 0) { this._expire("duration"); return true; }
        this._deadline = Date.now() + this.remainingSeconds * 1000;
        this.state = "running";
        this._scheduleTick();
      } else {
        if (!this.videoElement || typeof this.videoElement.addEventListener !== "function") return false;
        if (this._isVideoEnded()) { this._expire("video-ended"); return true; }
        this.videoElement.addEventListener("ended", this._handleVideoEnded);
        this._listeningToVideo = true;
        this.state = "running";
      }
      this._persist();
      this._emitStateChange("resume");
      this._emitTick("resume");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Add seconds to a running or paused duration timer. */
  addTime(amount, unit = "seconds") {
    try {
      if (this.isDestroyed || this.mode !== "duration" || !["running", "paused"].includes(this.state)) return false;
      if (isRecord(amount)) { unit = amount.unit ?? unit; amount = amount.amount ?? amount.seconds ?? amount.minutes; }
      const seconds = toSeconds(amount, unit);
      if (seconds === null || seconds <= 0) return false;
      const current = this.state === "running" ? this._refreshRemaining() : this.remainingSeconds;
      this.remainingSeconds = Math.min(MAX_DURATION_SECONDS, current + seconds);
      this.durationSeconds = Math.min(MAX_DURATION_SECONDS, this.durationSeconds + seconds);
      if (this.state === "running") this._deadline = Date.now() + this.remainingSeconds * 1000;
      this._persist();
      this._emitStateChange("add-time");
      this._emitTick("add-time");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  extend(amount, unit) { return this.addTime(amount, unit); }

  cancel() {
    try {
      if (this.isDestroyed) return false;
      const wasActive = ACTIVE_STATES.has(this.state);
      this._stopTimer();
      this._removeVideoListener();
      this._deadline = null;
      this.remainingSeconds = 0;
      this.state = "cancelled";
      this._persist();
      if (wasActive) {
        this._emitStateChange("cancel");
        this._emitTick("cancel");
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clear() {
    try {
      if (this.isDestroyed) return false;
      this._stopTimer();
      this._removeVideoListener();
      this._deadline = null;
      this.mode = "duration";
      this.durationSeconds = 0;
      this.remainingSeconds = 0;
      this.state = "idle";
      this._persist();
      this._emitStateChange("clear");
      this._emitTick("clear");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  reset() {
    try {
      if (this.isDestroyed) return false;
      this._stopTimer();
      this._removeVideoListener();
      this._deadline = null;
      this.remainingSeconds = this.durationSeconds;
      this.state = "idle";
      this._persist();
      this._emitStateChange("reset");
      this._emitTick("reset");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getRemainingTime() {
    try { return this.state === "running" && this.mode === "duration" ? this._refreshRemaining() : Math.max(0, this.remainingSeconds); }
    catch { return Math.max(0, this.remainingSeconds || 0); }
  }

  getState() {
    try {
      const remaining = this.getRemainingTime();
      return Object.freeze({
        state: this.state,
        mode: this.mode,
        durationSeconds: this.durationSeconds,
        remainingSeconds: remaining,
        remainingWholeSeconds: Math.ceil(remaining),
        isDestroyed: this.isDestroyed,
      });
    } catch { return null; }
  }

  getStatus() { return this.getState(); }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* Safe unsubscribe. */ } };
    } catch { return () => {}; }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._stopTimer();
      this._removeVideoListener();
      this._deadline = null;
      this.state = "destroyed";
      this._persist();
      this._emitStateChange("destroy");
      this._emitTick("destroy");
      this._subscribers.clear();
      this.onTick = null;
      this.onExpire = null;
      this.onPause = null;
      this.onStop = null;
      this.onStateChange = null;
      this.onError = null;
      this.storage = null;
      this.videoElement = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this._stopTimer();
      this._removeVideoListener();
      this.isDestroyed = true;
      this.state = "destroyed";
      this._subscribers.clear();
      return false;
    }
  }

  _scheduleTick() {
    try {
      if (this.isDestroyed || this.state !== "running" || this.mode !== "duration" || this._timerId !== null) return;
      this._timerId = setTimeout(() => {
        this._timerId = null;
        this._onTick();
      }, this.tickIntervalMs);
      if (this._timerId && typeof this._timerId.unref === "function") this._timerId.unref();
    } catch (error) { this._reportError(error); this._stopTimer(); }
  }

  _onTick() {
    try {
      if (this.isDestroyed || this.state !== "running" || this.mode !== "duration") return;
      this._refreshRemaining();
      this._emitTick("interval");
      if (this.remainingSeconds <= 0) { this._expire("duration"); return; }
      this._persist();
      this._scheduleTick();
    } catch (error) { this._reportError(error); }
  }

  _refreshRemaining() {
    try {
      if (this._deadline !== null) this.remainingSeconds = Math.max(0, (this._deadline - Date.now()) / 1000);
      return this.remainingSeconds;
    } catch { return this.remainingSeconds; }
  }

  _expire(reason) {
    try {
      if (this.isDestroyed || this.state === "expired" || this.state === "cancelled") return false;
      this._stopTimer();
      this._removeVideoListener();
      this._deadline = null;
      this.remainingSeconds = 0;
      this.state = "expired";
      this._persist();
      const state = this.getState();
      this._emitStateChange(reason);
      this._emitTick(reason);
      this._safeInvoke(this.onExpire, state);
      this._safeInvoke(this.onPause, state);
      this._safeInvoke(this.onStop, state);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _onVideoEnded() {
    try {
      this._removeVideoListener();
      if (this.state === "running" && this.mode === "end-of-video") this._expire("video-ended");
    } catch (error) { this._reportError(error); }
  }

  _isVideoEnded() {
    try { return Boolean(this.videoElement?.ended); }
    catch { return false; }
  }

  _removeVideoListener() {
    try {
      if (this._listeningToVideo && this.videoElement && typeof this.videoElement.removeEventListener === "function") {
        this.videoElement.removeEventListener("ended", this._handleVideoEnded);
      }
      this._listeningToVideo = false;
      return true;
    } catch { this._listeningToVideo = false; return false; }
  }

  _stopTimer() {
    try { if (this._timerId !== null) clearTimeout(this._timerId); this._timerId = null; return true; }
    catch { this._timerId = null; return false; }
  }

  _persist() {
    try {
      const state = {
        version: 1,
        mode: this.mode,
        durationSeconds: this.durationSeconds,
        remainingSeconds: this.getRemainingTime(),
        state: this.state === "running" && this.mode === "duration" ? "running" : this.state,
        savedAt: Date.now(),
      };
      const serialized = JSON.stringify(state);
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _load() {
    try {
      let raw = null;
      if (this.storage) {
        try { raw = this.storage.getItem(this.storageKey); }
        catch (error) { this._reportError(error); }
      }
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!isRecord(saved) || saved.version !== 1) return;
      const duration = normalizeNonNegative(saved.durationSeconds, 0);
      const remaining = normalizeNonNegative(saved.remainingSeconds, 0);
      this.mode = saved.mode === "end-of-video" ? "end-of-video" : "duration";
      this.durationSeconds = duration;
      this.remainingSeconds = remaining;
      if (saved.state === "running" && this.mode === "duration") {
        const elapsed = Math.max(0, (Date.now() - normalizeNonNegative(saved.savedAt, Date.now())) / 1000);
        this.remainingSeconds = Math.max(0, remaining - elapsed);
        if (this.remainingSeconds > 0) {
          this._deadline = Date.now() + this.remainingSeconds * 1000;
          this.state = "running";
          this._scheduleTick();
        } else {
          this.state = "expired";
          this.remainingSeconds = 0;
        }
      } else if (saved.state === "paused") {
        this.state = "paused";
      } else if (saved.state === "expired") {
        this.state = "expired";
        this.remainingSeconds = 0;
      } else if (saved.state === "cancelled") {
        this.state = "cancelled";
        this.remainingSeconds = 0;
      }
      // End-of-video timers are not resumed after reload because their media event source may differ.
      if (this.mode === "end-of-video") this.state = "paused";
    } catch (error) { this._reportError(error); }
  }

  _emitTick(reason) {
    try {
      const detail = Object.freeze({ ...this.getState(), reason });
      this._safeInvoke(this.onTick, detail);
      this._notify(detail);
    } catch (error) { this._reportError(error); }
  }

  _emitStateChange(reason) {
    try {
      const detail = Object.freeze({ ...this.getState(), reason });
      this._safeInvoke(this.onStateChange, detail);
      this._notify(detail);
    } catch (error) { this._reportError(error); }
  }

  _notify(detail) {
    try {
      for (const listener of [...this._subscribers]) this._safeInvoke(listener, detail);
    } catch (error) { this._reportError(error); }
  }

  _safeInvoke(callback, detail) {
    try { if (typeof callback === "function") callback(detail, this); }
    catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Sleep timer operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Error callbacks must not escape lifecycle operations. */ }
    } catch { /* Error reporting must not disrupt timer cleanup. */ }
  }
}

/** Create a sleep timer without throwing when browser APIs are unavailable. */
export function createSleepTimerController(options = {}) {
  try { return new SleepTimerController(options); }
  catch { return null; }
}

export default Object.freeze({ SleepTimerController, createSleepTimerController });
