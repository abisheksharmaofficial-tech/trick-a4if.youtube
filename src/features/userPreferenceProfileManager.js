const STORAGE_KEY = "trick-a4if-tube:user-preference-profile:v1";
const memoryStorage = new Map();
const DEFAULT_PREFERENCES = Object.freeze({
  theme: "system",
  language: "en",
  defaultPlaybackSpeed: 1,
  defaultQuality: "auto",
  autoplay: false,
  captionsEnabled: false,
  dataSaver: false,
  reducedMotion: false,
});
const THEMES = new Set(["system", "light", "dark"]);
const MAX_KEY_LENGTH = 256;
const MAX_TEXT_LENGTH = 2048;
const MAX_JSON_LENGTH = 1_000_000;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, fallback = "", maxLength = MAX_TEXT_LENGTH) {
  try {
    if (typeof value !== "string") return fallback;
    const normalized = value.trim().slice(0, maxLength);
    return normalized || fallback;
  } catch { return fallback; }
}

function cloneJson(value, fallback = null) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || serialized.length > MAX_JSON_LENGTH) return fallback;
    return JSON.parse(serialized);
  } catch { return fallback; }
}

function normalizeTheme(value, fallback = DEFAULT_PREFERENCES.theme) {
  try {
    const theme = normalizeText(value, fallback, 32).toLowerCase();
    return THEMES.has(theme) ? theme : fallback;
  } catch { return fallback; }
}

function normalizePlaybackSpeed(value, fallback = DEFAULT_PREFERENCES.defaultPlaybackSpeed, options = {}) {
  try {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    const min = Number.isFinite(Number(options.minPlaybackSpeed)) && Number(options.minPlaybackSpeed) > 0
      ? Number(options.minPlaybackSpeed) : 0.25;
    const max = Number.isFinite(Number(options.maxPlaybackSpeed)) && Number(options.maxPlaybackSpeed) >= min
      ? Number(options.maxPlaybackSpeed) : 4;
    return Math.min(max, Math.max(min, number));
  } catch { return fallback; }
}

function normalizePreferenceValue(key, value, fallback, options = {}) {
  try {
    switch (key) {
      case "theme": return normalizeTheme(value, normalizeTheme(fallback));
      case "language": return normalizeText(value, fallback, 64);
      case "defaultPlaybackSpeed": return normalizePlaybackSpeed(value, fallback, options);
      case "defaultQuality": return normalizeText(value, fallback, 128);
      case "autoplay": case "captionsEnabled": case "dataSaver": case "reducedMotion":
        return typeof value === "boolean' ? value : fallback;
      default: return cloneJson(value, fallback);
    }
  } catch { return fallback; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function') return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeKey(key) {
  try {
    if (typeof key !== "string') return "";
    const normalized = key.trim().slice(0, MAX_KEY_LENGTH);
    return normalized && !["__proto__", "prototype", "constructor"].includes(normalized) ? normalized : "";
  } catch { return ""; }
}

function normalizeProfile(input, defaults, options = {}) {
  try {
    const source = isRecord(input) ? input : {};
    const profile = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      profile[key] = normalizePreferenceValue(key, source[key] === undefined ? fallback : source[key], fallback, options);
    }
    for (const [candidate, value] of Object.entries(source)) {
      const key = normalizeKey(candidate);
      if (!key || Object.prototype.hasOwnProperty.call(profile, key)) continue;
      profile[key] = normalizePreferenceValue(key, value, undefined, options);
    }
    return profile;
  } catch { return { ...DEFAULT_PREFERENCES }; }
}

function deepFreeze(value) {
  try {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  } catch { return value; }
}

/**
 * Store and validate local user preferences. The manager only persists
 * preferences explicitly supplied by the caller or selected defaults; it does
 * not infer preferences or contact remote services.
 */
export class UserPreferenceProfileManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, STORAGE_KEY, 512) || STORAGE_KEY;
      this.validationOptions = Object.freeze({
        minPlaybackSpeed: settings.minPlaybackSpeed,
        maxPlaybackSpeed: settings.maxPlaybackSpeed,
      });
      this.defaults = normalizeProfile({ ...DEFAULT_PREFERENCES, ...(isRecord(settings.defaults) ? settings.defaults : {}) }, DEFAULT_PREFERENCES, this.validationOptions);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._subscribers = new Set();
      this._preferences = { ...this.defaults };
      this._load();
      if (isRecord(settings.preferences) || isRecord(settings.initialPreferences)) {
        this.setPreferences(settings.preferences ?? settings.initialPreferences, { source: "initial" });
      }
    } catch (error) {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.validationOptions = Object.freeze({});
      this.defaults = { ...DEFAULT_PREFERENCES };
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._subscribers = new Set();
      this._preferences = { ...DEFAULT_PREFERENCES };
    }
  }

  /** Return a frozen snapshot, or one named preference when given a key. */
  getPreferences() {
    try { return deepFreeze(cloneJson(this._preferences, { ...this.defaults })); }
    catch (error) { this._reportError(error); return deepFreeze({ ...this.defaults }); }
  }

  getAll() { return this.getPreferences(); }
  get(key) {
    try {
      const normalized = normalizeKey(key);
      if (!normalized || !Object.prototype.hasOwnProperty.call(this._preferences, normalized)) return undefined;
      return deepFreeze(cloneJson(this._preferences[normalized]));
    } catch (error) { this._reportError(error); return undefined; }
  }

  /** Set one preference or replace the profile with a supplied preference map. */
  setPreference(key, value, options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (isRecord(key)) return this.setPreferences(key, isRecord(value) ? value : options);
      const normalizedKey = normalizeKey(key);
      if (!normalizedKey) return false;
      const fallback = Object.prototype.hasOwnProperty.call(this.defaults, normalizedKey)
        ? this.defaults[normalizedKey] : undefined;
      const nextValue = normalizePreferenceValue(normalizedKey, value, fallback, this.validationOptions);
      if (nextValue === undefined) return false;
      const next = { ...this._preferences, [normalizedKey]: nextValue };
      return this._commit(next, options);
    } catch (error) { this._reportError(error); return false; }
  }

  set(key, value, options) { return this.setPreference(key, value, options); }

  setPreferences(preferences, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(preferences)) return false;
      const settings = isRecord(options) ? options : {};
      const base = settings.replace === true ? { ...this.defaults } : { ...this._preferences };
      const merged = { ...base, ...preferences };
      const normalized = normalizeProfile(merged, this.defaults, this.validationOptions);
      return this._commit(normalized, settings);
    } catch (error) { this._reportError(error); return false; }
  }

  patch(patch, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(patch)) return false;
      return this.setPreferences(patch, options);
    } catch (error) { this._reportError(error); return false; }
  }

  update(patch, options) { return this.patch(patch, options); }

  reset(keyOrOptions, maybeOptions = {}) {
    try {
      if (this.isDestroyed) return false;
      if (typeof keyOrOptions === "string") {
        const key = normalizeKey(keyOrOptions);
        if (!key || !Object.prototype.hasOwnProperty.call(this.defaults, key)) return false;
        return this._commit({ ...this._preferences, [key]: cloneJson(this.defaults[key]) }, maybeOptions);
      }
      const options = isRecord(keyOrOptions) ? keyOrOptions : maybeOptions;
      return this._commit(cloneJson(this.defaults, { ...DEFAULT_PREFERENCES }), options);
    } catch (error) { this._reportError(error); return false; }
  }

  resetPreference(key, options) { return this.reset(key, options); }
  resetAll(options) { return this.reset(options); }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 1, exportedAt: Date.now(), preferences: this.getPreferences() };
      return settings.asObject === true ? deepFreeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") {
        if (input.length > MAX_JSON_LENGTH) return false;
        payload = JSON.parse(input);
      }
      const preferences = isRecord(payload) && isRecord(payload.preferences) ? payload.preferences : payload;
      if (!isRecord(preferences)) return false;
      return this.setPreferences(preferences, { ...settings, replace: settings.replace !== false, source: settings.source ?? "import" });
    } catch (error) { this._reportError(error); return false; }
  }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { return this._subscribers.delete(listener); } catch { return false; } };
    } catch { return () => {}; }
  }

  unsubscribe(listener) {
    try { return this._subscribers.delete(listener); }
    catch (error) { this._reportError(error); return false; }
  }

  getState() {
    try { return Object.freeze({ preferences: this.getPreferences(), isDestroyed: this.isDestroyed }); }
    catch { return null; }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._persist();
      this.isDestroyed = true;
      this._subscribers.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; this._subscribers.clear(); return false; }
  }

  _commit(next, options = {}) {
    try {
      const normalized = normalizeProfile(next, this.defaults, this.validationOptions);
      const before = JSON.stringify(this._preferences);
      const after = JSON.stringify(normalized);
      if (before === after) return true;
      const previous = this.getPreferences();
      this._preferences = normalized;
      if (options?.persist !== false) this._persist();
      const event = Object.freeze({
        type: options?.source === "import" ? "imported" : "changed",
        source: normalizeText(options?.source, "api", 64),
        preferences: this.getPreferences(),
        previousPreferences: previous,
      });
      this._notify(event);
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
      if (raw.length > MAX_JSON_LENGTH) throw new Error("Stored preference profile exceeds the allowed size.");
      const payload = JSON.parse(raw);
      const preferences = isRecord(payload) && isRecord(payload.preferences) ? payload.preferences : payload;
      if (isRecord(preferences)) this._preferences = normalizeProfile(preferences, this.defaults, this.validationOptions);
    } catch (error) { this._reportError(error); }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, preferences: this._preferences });
      if (serialized.length > MAX_JSON_LENGTH) return false;
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(event) {
    try {
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("User preference profile operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callbacks. */ }
    } catch { /* Error handling must not interrupt preference operations. */ }
  }
}

/** Create a preference profile manager without throwing if setup fails. */
export function createUserPreferenceProfileManager(options = {}) {
  try { return new UserPreferenceProfileManager(options); }
  catch { return null; }
}

export { DEFAULT_PREFERENCES };
export default Object.freeze({ UserPreferenceProfileManager, createUserPreferenceProfileManager, DEFAULT_PREFERENCES });
