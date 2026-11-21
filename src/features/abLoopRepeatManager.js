const DEFAULT_MIN_SEGMENT_DURATION = 0.1;
const DEFAULT_SEEK_EPSILON = 0.05;
const STATE_EVENTS = Object.freeze(["statechange", "pointchange", "loop", "complete", "error"]);

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeFiniteTime(value) {
  try {
    const time = Number(value);
    return Number.isFinite(time) && time >= 0 ? time : null;
  } catch { return null; }
}

function normalizePositive(value, fallback, allowZero = false) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0) ? number : fallback;
  } catch { return fallback; }
}

function safeInvoke(callback, detail, manager) {
  try {
    if (typeof callback === "function") callback(detail, manager);
  } catch (error) { manager._reportError(error); }
}

/**
 * Manage an A-B playback loop against a caller-owned media element. Call
 * evaluate() from a timeupdate handler or rely on the optional listener setup.
 */
export class AbLoopRepeatManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.mediaElement = settings.mediaElement ?? settings.videoElement ?? settings.audioElement ?? null;
    this.minSegmentDuration = normalizePositive(settings.minSegmentDuration, DEFAULT_MIN_SEGMENT_DURATION);
    this.seekEpsilon = normalizePositive(settings.seekEpsilon, DEFAULT_SEEK_EPSILON, true);
    this.maxRepeats = this._normalizeMaxRepeats(settings.maxRepeats ?? settings.maxRepeatCount);
    this.autoOrderPoints = settings.autoOrderPoints !== false && settings.requireABeforeB !== true;
    this.pointA = null;
    this.pointB = null;
    this.loopEnabled = false;
    this.loopCount = 0;
    this.isDestroyed = false;
    this.lastError = null;
    this.onStateChange = typeof settings.onStateChange === "function" ? settings.onStateChange : null;
    this.onPointChange = typeof settings.onPointChange === "function" ? settings.onPointChange : null;
    this.onLoop = typeof settings.onLoop === "function" ? settings.onLoop : null;
    this.onComplete = typeof settings.onComplete === "function" ? settings.onComplete : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this._listeners = new Map(STATE_EVENTS.map((eventName) => [eventName, new Set()]));
    this._boundTimeUpdate = () => this.evaluate();
    this._boundSeeking = () => this.evaluate();
    this._attachMediaListeners();

    const initialA = normalizeFiniteTime(settings.pointA ?? settings.a);
    const initialB = normalizeFiniteTime(settings.pointB ?? settings.b);
    if (initialA !== null && initialB !== null) this.setPoints(initialA, initialB);
    else if (initialA !== null) this.setPointA(initialA);
    else if (initialB !== null) this.setPointB(initialB);
    if (settings.enabled === true || settings.loopEnabled === true) this.enable();
  }

  _normalizeMaxRepeats(value) {
    try {
      if (value == null || value === Infinity) return null;
      const limit = Number(value);
      return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : null;
    } catch { return null; }
  }

  _attachMediaListeners() {
    try {
      if (!this.mediaElement || typeof this.mediaElement.addEventListener !== "function") return false;
      this.mediaElement.addEventListener("timeupdate", this._boundTimeUpdate);
      this.mediaElement.addEventListener("seeking", this._boundSeeking);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("A-B loop operation failed.");
      this._emit("error", { error: this.lastError });
      safeInvoke(this.onError, this.lastError, this);
    } catch { /* Error handling must not interrupt playback or cleanup. */ }
  }

  _emit(type, detail) {
    try {
      const listeners = this._listeners?.get(type);
      if (!listeners) return;
      for (const listener of [...listeners]) safeInvoke(listener, detail, this);
    } catch (error) { this._reportError(error); }
  }

  _getDuration() {
    try {
      const duration = Number(this.mediaElement?.duration);
      return Number.isFinite(duration) && duration >= 0 ? duration : null;
    } catch { return null; }
  }

  _validatePointPair(a, b) {
    try {
      if (a === null || b === null) return true;
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return false;
      if (b - a < this.minSegmentDuration) return false;
      const duration = this._getDuration();
      return duration === null || (a <= duration && b <= duration);
    } catch { return false; }
  }

  _setPoints(a, b, changedPoint = "both") {
    try {
      if (this.isDestroyed || !this._validatePointPair(a, b)) return false;
      const oldA = this.pointA;
      const oldB = this.pointB;
      this.pointA = a;
      this.pointB = b;
      this.loopCount = 0;
      const detail = Object.freeze({ pointA: a, pointB: b, changedPoint, previousA: oldA, previousB: oldB });
      this._emit("pointchange", detail);
      safeInvoke(this.onPointChange, detail, this);
      this._emitStateChange("points");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  setPointA(value) {
    try {
      if (this.isDestroyed) return false;
      const time = normalizeFiniteTime(value);
      if (time === null) return false;
      let a = time;
      let b = this.pointB;
      if (b !== null && a >= b) {
        if (!this.autoOrderPoints) return false;
        [a, b] = [b, a];
      }
      return this._setPoints(a, b, "A");
    } catch (error) { this._reportError(error); return false; }
  }

  setPointB(value) {
    try {
      if (this.isDestroyed) return false;
      const time = normalizeFiniteTime(value);
      if (time === null) return false;
      let a = this.pointA;
      let b = time;
      if (a !== null && b <= a) {
        if (!this.autoOrderPoints) return false;
        [a, b] = [b, a];
      }
      return this._setPoints(a, b, "B");
    } catch (error) { this._reportError(error); return false; }
  }

  setPoints(pointA, pointB, options = {}) {
    try {
      if (this.isDestroyed) return false;
      let a = normalizeFiniteTime(pointA);
      let b = normalizeFiniteTime(pointB);
      if (a === null || b === null) return false;
      const autoOrder = isRecord(options) && typeof options.autoOrder === "boolean"
        ? options.autoOrder : this.autoOrderPoints;
      if (a >= b) {
        if (!autoOrder) return false;
        [a, b] = [b, a];
      }
      return this._setPoints(a, b, "both");
    } catch (error) { this._reportError(error); return false; }
  }

  setPoint(point, value) {
    try {
      const normalized = String(point).toUpperCase();
      return normalized === "A" ? this.setPointA(value) : normalized === "B" ? this.setPointB(value) : false;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Set either loop point to the current media position. */
  markPoint(point) {
    try {
      const time = normalizeFiniteTime(this.mediaElement?.currentTime);
      return time === null ? false : this.setPoint(point, time);
    } catch (error) { this._reportError(error); return false; }
  }

  setPointAToCurrentTime() { return this.markPoint("A"); }
  setPointBToCurrentTime() { return this.markPoint("B"); }

  clearPoints() {
    try {
      if (this.isDestroyed) return false;
      const hadPoints = this.pointA !== null || this.pointB !== null;
      this.pointA = null;
      this.pointB = null;
      this.loopCount = 0;
      if (this.loopEnabled) this.disable();
      if (hadPoints) {
        const detail = Object.freeze({ pointA: null, pointB: null, changedPoint: "both", cleared: true });
        this._emit("pointchange", detail);
        safeInvoke(this.onPointChange, detail, this);
        this._emitStateChange("clear");
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  reset() {
    try {
      if (this.isDestroyed) return false;
      this.loopEnabled = false;
      this.pointA = null;
      this.pointB = null;
      this.loopCount = 0;
      this._emitStateChange("reset");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  enable() {
    try {
      if (this.isDestroyed || this.pointA === null || this.pointB === null || !this._validatePointPair(this.pointA, this.pointB)) return false;
      if (this.maxRepeats === 0) return false;
      if (this.loopEnabled) return true;
      this.loopEnabled = true;
      this.loopCount = 0;
      this._emitStateChange("enable");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  disable() {
    try {
      if (this.isDestroyed) return false;
      if (!this.loopEnabled) return true;
      this.loopEnabled = false;
      this._emitStateChange("disable");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  toggle(force) {
    try {
      if (this.isDestroyed) return false;
      const enable = typeof force === "boolean" ? force : !this.loopEnabled;
      return enable ? this.enable() : this.disable();
    } catch (error) { this._reportError(error); return false; }
  }

  setEnabled(enabled) { return this.toggle(Boolean(enabled)); }
  toggleLoop(force) { return this.toggle(force); }

  setMaxRepeats(value) {
    try {
      if (this.isDestroyed) return false;
      const limit = this._normalizeMaxRepeats(value);
      if (value != null && value !== Infinity && limit === null) return false;
      this.maxRepeats = limit;
      if (limit !== null && this.loopCount >= limit && this.loopEnabled) {
        this.loopEnabled = false;
        this._emit("complete", { loopCount: this.loopCount, maxRepeats: limit, reason: "limit-updated" });
      }
      this._emitStateChange("max-repeats");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Check playback position; seek to A when B is reached. */
  evaluate(currentTime = this.mediaElement?.currentTime) {
    try {
      if (this.isDestroyed || !this.loopEnabled || this.pointA === null || this.pointB === null) return false;
      const time = normalizeFiniteTime(currentTime);
      if (time === null || time + this.seekEpsilon < this.pointB) return false;
      if (this.maxRepeats !== null && this.loopCount >= this.maxRepeats) {
        this.loopEnabled = false;
        const completed = Object.freeze({ loopCount: this.loopCount, maxRepeats: this.maxRepeats, pointA: this.pointA, pointB: this.pointB });
        this._emit("complete", completed);
        safeInvoke(this.onComplete, completed, this);
        this._emitStateChange("complete");
        return false;
      }
      if (!this.mediaElement || !("currentTime" in this.mediaElement)) return false;
      this.mediaElement.currentTime = this.pointA;
      this.loopCount += 1;
      const detail = Object.freeze({ loopCount: this.loopCount, pointA: this.pointA, pointB: this.pointB, fromTime: time, toTime: this.pointA });
      this._emit("loop", detail);
      safeInvoke(this.onLoop, detail, this);
      this._emitStateChange("loop");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _emitStateChange(reason) {
    try {
      const state = this.getState();
      const detail = Object.freeze({ ...state, reason });
      this._emit("statechange", detail);
      safeInvoke(this.onStateChange, detail, this);
    } catch (error) { this._reportError(error); }
  }

  getState() {
    try {
      return Object.freeze({
        pointA: this.pointA,
        pointB: this.pointB,
        a: this.pointA,
        b: this.pointB,
        hasPoints: this.pointA !== null && this.pointB !== null,
        segmentDuration: this.pointA !== null && this.pointB !== null ? this.pointB - this.pointA : null,
        loopEnabled: this.loopEnabled,
        enabled: this.loopEnabled,
        loopCount: this.loopCount,
        maxRepeats: this.maxRepeats,
        isDestroyed: this.isDestroyed,
      });
    } catch { return null; }
  }

  addEventListener(type, listener) {
    try {
      const listeners = this._listeners.get(type);
      if (!listeners || typeof listener !== "function" || this.isDestroyed) return false;
      listeners.add(listener);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeEventListener(type, listener) {
    try { return this._listeners.get(type)?.delete(listener) ?? false; }
    catch (error) { this._reportError(error); return false; }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.mediaElement?.removeEventListener?.("timeupdate", this._boundTimeUpdate);
      this.mediaElement?.removeEventListener?.("seeking", this._boundSeeking);
      this.loopEnabled = false;
      this._emitStateChange("destroy");
      for (const listeners of this._listeners.values()) listeners.clear();
      this.mediaElement = null;
      this.onStateChange = null;
      this.onPointChange = null;
      this.onLoop = null;
      this.onComplete = null;
      this.onError = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a loop manager without throwing in unsupported environments. */
export function createAbLoopRepeatManager(options = {}) {
  try { return new AbLoopRepeatManager(options); }
  catch { return null; }
}

export default Object.freeze({
  AbLoopRepeatManager,
  createAbLoopRepeatManager,
});
