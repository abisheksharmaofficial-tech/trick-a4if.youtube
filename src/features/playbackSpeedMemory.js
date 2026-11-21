const STORAGE_KEY = "trick-a4if-tube:playback-speed-memory:v1";
const DEFAULT_PRESETS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
const DEFAULT_MIN_RATE = 0.25;
const DEFAULT_MAX_RATE = 4;
const DEFAULT_STEP = 0.25;
const memoryStorage = new Map();

function isRecord(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function normalizeKey(value) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, 512);
  } catch {
    return "";
  }
}

function normalizeBounds(minimum, maximum) {
  try {
    let min = Number(minimum);
    let max = Number(maximum);
    if (!Number.isFinite(min) || min <= 0) min = DEFAULT_MIN_RATE;
    if (!Number.isFinite(max) || max < min) max = DEFAULT_MAX_RATE;
    return { min, max };
  } catch {
    return { min: DEFAULT_MIN_RATE, max: DEFAULT_MAX_RATE };
  }
}

function normalizePresets(value, min, max) {
  try {
    const candidates = Array.isArray(value) ? value : DEFAULT_PRESETS;
    const rates = candidates.map(Number)
      .filter((rate) => Number.isFinite(rate) && rate > 0 && rate >= min && rate <= max);
    if (!rates.some((rate) => rate === 1) && min <= 1 && max >= 1) rates.push(1);
    return Object.freeze([...new Set(rates)].sort((left, right) => left - right));
  } catch {
    return DEFAULT_PRESETS;
  }
}

function normalizeRate(value, min, max) {
  try {
    const rate = typeof value === "number" ? value : Number(value);
    return Number.isFinite(rate) && rate > 0 ? Math.min(max, Math.max(min, rate)) : null;
  } catch {
    return null;
  }
}

function normalizeState(input, min, max) {
  try {
    const state = { global: 1, categories: {}, videos: {} };
    if (!isRecord(input)) return state;
    const globalRate = normalizeRate(input.global, min, max);
    if (globalRate !== null) state.global = globalRate;
    for (const scope of ["categories", "videos"]) {
      const entries = input[scope];
      if (!isRecord(entries)) continue;
      for (const [key, value] of Object.entries(entries)) {
        const normalizedKey = normalizeKey(key);
        const rate = normalizeRate(value, min, max);
        if (normalizedKey && rate !== null) state[scope][normalizedKey] = rate;
      }
    }
    return state;
  } catch {
    return { global: 1, categories: {}, videos: {} };
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
 * Remember playback rates globally and optionally per category or video.
 * Rates are validated and clamped to the configured positive bounds.
 */
export class PlaybackSpeedMemory {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    const bounds = normalizeBounds(settings.minRate ?? settings.minSpeed, settings.maxRate ?? settings.maxSpeed);
    this.minRate = bounds.min;
    this.maxRate = bounds.max;
    this.presets = normalizePresets(settings.presets, this.minRate, this.maxRate);
    const step = Number(settings.step ?? settings.stepSize ?? DEFAULT_STEP);
    this.step = Number.isFinite(step) && step > 0 ? step : DEFAULT_STEP;
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeKey(settings.storageKey) || STORAGE_KEY;
    this.mediaElement = settings.mediaElement ?? settings.videoElement ?? settings.element ?? null;
    this.category = normalizeKey(settings.category);
    this.videoId = normalizeKey(settings.videoId);
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this._data = { global: 1, categories: {}, videos: {} };
    this._load();

    try {
      const initialRate = normalizeRate(settings.rate ?? settings.playbackRate, this.minRate, this.maxRate);
      if (initialRate !== null) this.setRate(initialRate, { scope: settings.scope ?? "global", apply: settings.applyOnCreate !== false });
      else if (this.mediaElement) this.applyToMediaElement(this.mediaElement);
    } catch (error) {
      this._reportError(error);
    }
  }

  /** Get effective rate according to video, category, then global precedence. */
  getRate(options = {}) {
    try {
      const scope = isRecord(options) ? options : {};
      const videoId = normalizeKey(scope.videoId ?? this.videoId);
      const category = normalizeKey(scope.category ?? this.category);
      if (videoId && Object.prototype.hasOwnProperty.call(this._data.videos, videoId)) return this._data.videos[videoId];
      if (category && Object.prototype.hasOwnProperty.call(this._data.categories, category)) return this._data.categories[category];
      return this._data.global;
    } catch {
      return 1;
    }
  }

  /** Get a specifically scoped stored rate (without fallback inheritance). */
  getStoredRate(scope = "global", key = "") {
    try {
      if (scope === "global") return this._data.global;
      const normalizedKey = normalizeKey(key || (scope === "category" ? this.category : this.videoId));
      if (!normalizedKey) return null;
      const bucket = scope === "category" ? this._data.categories : scope === "video" ? this._data.videos : null;
      return bucket && Object.prototype.hasOwnProperty.call(bucket, normalizedKey) ? bucket[normalizedKey] : null;
    } catch {
      return null;
    }
  }

  /** Set and persist a rate globally, for a category, or for a video. */
  setRate(value, options = {}) {
    try {
      const settings = typeof options === "string" ? { scope: options } : (isRecord(options) ? options : {});
      const rate = normalizeRate(value, this.minRate, this.maxRate);
      if (rate === null) return false;
      const scope = settings.scope ?? "global";
      if (scope === "global") {
        this._data.global = rate;
      } else if (scope === "category") {
        const key = normalizeKey(settings.category ?? settings.key ?? this.category);
        if (!key) return false;
        this._data.categories[key] = rate;
        if (settings.category !== undefined) this.category = key;
      } else if (scope === "video") {
        const key = normalizeKey(settings.videoId ?? settings.key ?? this.videoId);
        if (!key) return false;
        this._data.videos[key] = rate;
        if (settings.videoId !== undefined) this.videoId = key;
      } else {
        return false;
      }
      this._persist();
      if (settings.apply !== false && (settings.mediaElement || this.mediaElement)) {
        this.applyToMediaElement(settings.mediaElement ?? this.mediaElement, rate);
      }
      this._notifyChange({ scope, key: scope === "category" ? this.category : scope === "video" ? this.videoId : "", rate });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set a category-specific playback rate. */
  setCategoryRate(category, rate, options = {}) {
    try {
      return this.setRate(rate, { ...(isRecord(options) ? options : {}), scope: "category", category });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set a video-specific playback rate. */
  setVideoRate(videoId, rate, options = {}) {
    try {
      return this.setRate(rate, { ...(isRecord(options) ? options : {}), scope: "video", videoId });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Apply the effective or explicitly supplied rate to a media element. */
  applyToMediaElement(mediaElement = this.mediaElement, rate = undefined, options = {}) {
    try {
      if (!mediaElement || typeof mediaElement !== "object" || !("playbackRate" in mediaElement)) return false;
      const value = normalizeRate(rate ?? this.getRate(options), this.minRate, this.maxRate);
      if (value === null) return false;
      mediaElement.playbackRate = value;
      this.mediaElement = mediaElement;
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Apply the effective remembered rate for the configured/current context. */
  apply(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const element = settings.mediaElement ?? this.mediaElement;
      const rate = this.getRate(settings);
      return this.applyToMediaElement(element, rate);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Increase the effective playback rate by one preset (or configured step). */
  stepUp(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const current = this.getRate(settings);
      const next = this.presets.find((rate) => rate > current + Number.EPSILON)
        ?? Math.min(this.maxRate, current + this.step);
      return this.setRate(next, { ...settings, scope: settings.scope ?? this._preferredScope(settings) });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Decrease the effective playback rate by one preset (or configured step). */
  stepDown(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const current = this.getRate(settings);
      const previous = this.presets.filter((rate) => rate < current - Number.EPSILON).at(-1)
        ?? Math.max(this.minRate, current - this.step);
      return this.setRate(previous, { ...settings, scope: settings.scope ?? this._preferredScope(settings) });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Aliases for UI controls. */
  increase(options = {}) {
    try { return this.stepUp(options); } catch (error) { this._reportError(error); return false; }
  }

  decrease(options = {}) {
    try { return this.stepDown(options); } catch (error) { this._reportError(error); return false; }
  }

  /** Reset a scope to 1x, or remove a scoped override to inherit its parent. */
  reset(options = {}) {
    try {
      const settings = typeof options === "string" ? { scope: options } : (isRecord(options) ? options : {});
      const scope = settings.scope ?? "global";
      if (settings.inherit === true && scope !== "global") {
        const key = normalizeKey(scope === "category"
          ? settings.category ?? settings.key ?? this.category
          : settings.videoId ?? settings.key ?? this.videoId);
        const bucket = scope === "category" ? this._data.categories : scope === "video" ? this._data.videos : null;
        if (!bucket || !key) return false;
        delete bucket[key];
        this._persist();
        const rate = this.getRate(settings);
        if (settings.apply !== false && (settings.mediaElement || this.mediaElement)) {
          this.applyToMediaElement(settings.mediaElement ?? this.mediaElement, rate);
        }
        this._notifyChange({ scope, key, rate, reset: true });
        return true;
      }
      return this.setRate(1, { ...settings, scope });
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for reset(). */
  resetRate(options = {}) {
    try { return this.reset(options); } catch (error) { this._reportError(error); return false; }
  }

  /** Update active category/video context and optionally apply its remembered rate. */
  setContext(context = {}, options = {}) {
    try {
      if (!isRecord(context)) return false;
      if (context.category !== undefined) this.category = normalizeKey(context.category);
      if (context.videoId !== undefined) this.videoId = normalizeKey(context.videoId);
      if (context.mediaElement !== undefined) this.mediaElement = context.mediaElement;
      const settings = isRecord(options) ? options : {};
      return settings.apply === false ? true : this.apply();
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Return an immutable copy of all stored rates. */
  getSettings() {
    try {
      return Object.freeze({
        global: this._data.global,
        categories: Object.freeze({ ...this._data.categories }),
        videos: Object.freeze({ ...this._data.videos }),
        minRate: this.minRate,
        maxRate: this.maxRate,
        presets: this.presets,
        category: this.category,
        videoId: this.videoId,
      });
    } catch {
      return null;
    }
  }

  _preferredScope(options = {}) {
    try {
      if (options.videoId ?? this.videoId) return "video";
      if (options.category ?? this.category) return "category";
      return "global";
    } catch {
      return "global";
    }
  }

  _load() {
    try {
      let raw = null;
      if (this.storage) raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this._data = normalizeState(parsed?.data ?? parsed, this.minRate, this.maxRate);
    } catch (error) {
      this._data = { global: 1, categories: {}, videos: {} };
      this._reportError(error);
    }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, data: this._data });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try {
          this.storage.setItem(this.storageKey, serialized);
          return true;
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

  _notifyChange(detail) {
    try {
      if (this.onChange) this.onChange(Object.freeze({ ...detail, settings: this.getSettings() }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Playback speed memory operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt playback-rate operations.
    }
  }
}

/** Create a playback speed memory manager without throwing on storage failures. */
export function createPlaybackSpeedMemory(options = {}) {
  try {
    return new PlaybackSpeedMemory(options);
  } catch {
    return null;
  }
}

export const PLAYBACK_SPEED_PRESETS = DEFAULT_PRESETS;

export default Object.freeze({
  PLAYBACK_SPEED_PRESETS,
  PlaybackSpeedMemory,
  createPlaybackSpeedMemory,
});
