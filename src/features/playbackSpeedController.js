const STORAGE_KEY = "trick-a4if-tube:playback-speed-controller:v1";
const DEFAULT_MIN_RATE = 0.25;
const DEFAULT_MAX_RATE = 4;
const DEFAULT_RATE = 1;
const DEFAULT_STEP = 0.25;
const DEFAULT_PRESETS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
const memoryStorage = new Map();

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, fallback = "", maxLength = 512) {
  try {
    if (typeof value !== "string") return fallback;
    const text = value.trim().slice(0, maxLength);
    return text || fallback;
  } catch {
    return fallback;
  }
}

function normalizeBounds(minValue, maxValue) {
  try {
    const minCandidate = Number(minValue);
    const minRate = Number.isFinite(minCandidate) && minCandidate > 0
      ? minCandidate
      : DEFAULT_MIN_RATE;
    const maxCandidate = Number(maxValue);
    const maxRate = Number.isFinite(maxCandidate) && maxCandidate >= minRate
      ? maxCandidate
      : Math.max(DEFAULT_MAX_RATE, minRate);
    return { minRate, maxRate };
  } catch {
    return { minRate: DEFAULT_MIN_RATE, maxRate: DEFAULT_MAX_RATE };
  }
}

function normalizeRate(value, minRate, maxRate) {
  try {
    if (value === null || value === undefined || value === "") return null;
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0
      ? Math.min(maxRate, Math.max(minRate, rate))
      : null;
  } catch {
    return null;
  }
}

function normalizeStep(value) {
  try {
    const step = Number(value);
    return Number.isFinite(step) && step > 0 ? step : DEFAULT_STEP;
  } catch {
    return DEFAULT_STEP;
  }
}

function normalizePresets(value, minRate, maxRate) {
  try {
    const candidates = Array.isArray(value) ? value : DEFAULT_PRESETS;
    const rates = candidates
      .map((candidate) => normalizeRate(candidate, minRate, maxRate))
      .filter((rate) => rate !== null);
    return Object.freeze([...new Set(rates)].sort((left, right) => left - right));
  } catch {
    return DEFAULT_PRESETS;
  }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function"
      && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Control playback speed and optionally apply it to a caller-owned media
 * element. Rates are clamped to the configured positive bounds.
 */
export class PlaybackSpeedController {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    const bounds = normalizeBounds(settings.minRate ?? settings.minSpeed, settings.maxRate ?? settings.maxSpeed);
    this.minRate = bounds.minRate;
    this.maxRate = bounds.maxRate;
    this.step = normalizeStep(settings.step ?? settings.stepSize);
    this.presets = normalizePresets(settings.presets, this.minRate, this.maxRate);
    this.defaultRate = normalizeRate(settings.defaultRate ?? settings.defaultSpeed ?? DEFAULT_RATE, this.minRate, this.maxRate)
      ?? normalizeRate(DEFAULT_RATE, this.minRate, this.maxRate)
      ?? this.minRate;
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, STORAGE_KEY) || STORAGE_KEY;
    this.mediaElement = settings.mediaElement ?? settings.videoElement ?? settings.element ?? null;
    this.applyToMediaElement = settings.applyToMediaElement !== false && settings.apply !== false;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._subscribers = new Set();
    this._boundRateChange = () => this._handleMediaRateChange();
    this._isApplying = false;

    const storedRate = this._load();
    const initialRate = normalizeRate(settings.rate ?? settings.speed, this.minRate, this.maxRate)
      ?? storedRate
      ?? this.defaultRate;
    this.speed = initialRate;
    this.rate = initialRate;
    this._attachMediaListener();
    if (this.applyToMediaElement) this._applyRate(initialRate);
  }

  /** Set playback speed; valid positive rates are clamped to configured bounds. */
  setSpeed(value, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const rate = normalizeRate(value, this.minRate, this.maxRate);
      if (rate === null) return false;
      const settings = isRecord(options) ? options : {};
      const previousRate = this.speed;
      this.speed = rate;
      this.rate = rate;

      const shouldApply = settings.apply !== false && this.applyToMediaElement;
      const applied = shouldApply ? this._applyRate(rate) : true;
      this._persist();
      if (previousRate !== rate || settings.forceNotify === true) {
        this._notify({ reason: settings.reason ?? "set", previousRate, rate, speed: rate, applied });
      }
      return applied;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Increase to the next configured preset, or by the configured step. */
  increaseSpeed() {
    try {
      if (this.isDestroyed) return false;
      const nextPreset = this.presets.find((rate) => rate > this.speed + Number.EPSILON);
      const nextRate = nextPreset ?? Math.min(this.maxRate, this.speed + this.step);
      if (nextRate <= this.speed) return false;
      return this.setSpeed(nextRate, { reason: "increase" });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Decrease to the previous configured preset, or by the configured step. */
  decreaseSpeed() {
    try {
      if (this.isDestroyed) return false;
      const previousPreset = this.presets.filter((rate) => rate < this.speed - Number.EPSILON).at(-1);
      const nextRate = previousPreset ?? Math.max(this.minRate, this.speed - this.step);
      if (nextRate >= this.speed) return false;
      return this.setSpeed(nextRate, { reason: "decrease" });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Restore and persist the configured default rate. */
  resetSpeed() {
    try {
      return this.setSpeed(this.defaultRate, { reason: "reset", forceNotify: true });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Bind or replace the media element and optionally apply the current speed. */
  bindMediaElement(mediaElement, options = {}) {
    try {
      if (this.isDestroyed) return false;
      this._detachMediaListener();
      this.mediaElement = mediaElement ?? null;
      const settings = isRecord(options) ? options : {};
      if (settings.apply !== undefined) this.applyToMediaElement = settings.apply !== false;
      this._attachMediaListener();
      return this.applyToMediaElement ? this._applyRate(this.speed) : true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Register a state subscriber; returns an unsubscribe function. */
  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => false;
      this._subscribers.add(listener);
      let subscribed = true;
      return () => {
        try {
          if (!subscribed) return false;
          subscribed = false;
          return this._subscribers.delete(listener);
        } catch {
          return false;
        }
      };
    } catch (error) {
      this._reportError(error);
      return () => false;
    }
  }

  unsubscribe(listener) {
    try { return this._subscribers.delete(listener); }
    catch (error) { this._reportError(error); return false; }
  }

  getState() {
    try {
      return Object.freeze({
        speed: this.speed,
        rate: this.speed,
        defaultRate: this.defaultRate,
        minRate: this.minRate,
        maxRate: this.maxRate,
        step: this.step,
        presets: this.presets,
        hasMediaElement: Boolean(this.mediaElement),
        isDestroyed: this.isDestroyed,
      });
    } catch {
      return null;
    }
  }

  /** Remove media listeners and release element and callback references. */
  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._detachMediaListener();
      this._subscribers.clear();
      this.mediaElement = null;
      this.storage = null;
      this.onChange = null;
      this.onError = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this._detachMediaListener();
      this.isDestroyed = true;
      return false;
    }
  }

  _load() {
    try {
      let serialized = null;
      try {
        serialized = this.storage?.getItem(this.storageKey) ?? null;
      } catch (error) {
        this._reportError(error);
      }
      if (typeof serialized !== "string" || !serialized) {
        serialized = memoryStorage.get(this.storageKey) ?? null;
      }
      if (typeof serialized !== "string" || !serialized) return null;
      const parsed = JSON.parse(serialized);
      const storedValue = isRecord(parsed) ? parsed.speed ?? parsed.rate : parsed;
      return normalizeRate(storedValue, this.minRate, this.maxRate);
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, speed: this.speed });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try {
          this.storage.setItem(this.storageKey, serialized);
        } catch (error) {
          this._reportError(error);
        }
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _applyRate(rate) {
    try {
      const media = this.mediaElement;
      if (!media || typeof media !== "object" || !("playbackRate" in media)) return false;
      this._isApplying = true;
      media.playbackRate = rate;
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    } finally {
      this._isApplying = false;
    }
  }

  _attachMediaListener() {
    try {
      const media = this.mediaElement;
      if (!media || typeof media.addEventListener !== "function") return false;
      media.addEventListener("ratechange", this._boundRateChange);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _detachMediaListener() {
    try {
      const media = this.mediaElement;
      if (media && typeof media.removeEventListener === "function") {
        media.removeEventListener("ratechange", this._boundRateChange);
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _handleMediaRateChange() {
    try {
      if (this.isDestroyed || this._isApplying) return;
      const rate = normalizeRate(this.mediaElement?.playbackRate, this.minRate, this.maxRate);
      if (rate === null || rate === this.speed) return;
      const previousRate = this.speed;
      this.speed = rate;
      this.rate = rate;
      this._persist();
      this._notify({ reason: "media-ratechange", previousRate, rate, speed: rate, applied: true });
    } catch (error) {
      this._reportError(error);
    }
  }

  _notify(detail) {
    try {
      const event = Object.freeze({ ...detail, state: this.getState() });
      try { this.onChange?.(event, this); }
      catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); }
        catch (error) { this._reportError(error); }
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Playback speed controller operation failed.");
      try { this.onError?.(this.lastError, this); }
      catch { /* Error callbacks must not escape controller operations. */ }
    } catch {
      // Error reporting must never interrupt speed control or cleanup.
    }
  }
}

/** Create a playback speed controller without throwing on initialization errors. */
export function createPlaybackSpeedController(options = {}) {
  try { return new PlaybackSpeedController(options); }
  catch { return null; }
}

export const PLAYBACK_SPEED_CONTROLLER_PRESETS = DEFAULT_PRESETS;

export default Object.freeze({
  PLAYBACK_SPEED_CONTROLLER_PRESETS,
  PlaybackSpeedController,
  createPlaybackSpeedController,
});
