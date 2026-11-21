const STORAGE_KEY = "trick-a4if-tube:player-state:v1";
const memoryStorage = new Map();
const MAX_VIDEO_ID_LENGTH = 512;
const MAX_QUALITY_LENGTH = 128;
const DEFAULT_STATE = Object.freeze({
  videoId: "",
  currentTime: 0,
  duration: 0,
  paused: true,
  ended: false,
  buffering: false,
  playbackRate: 1,
  volume: 1,
  muted: false,
  quality: "",
  updatedAt: 0,
});

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

function normalizeText(value, maxLength) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeNonNegative(value, fallback = 0) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizePositive(value, fallback = 1) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeState(input, previous = DEFAULT_STATE, now = Date.now()) {
  try {
    const source = isRecord(input) ? input : {};
    const duration = normalizeNonNegative(source.duration, previous.duration);
    const currentTime = normalizeNonNegative(source.currentTime, previous.currentTime);
    const safeCurrentTime = duration > 0 ? Math.min(currentTime, duration) : currentTime;
    const updatedAtValue = normalizeNonNegative(source.updatedAt, now);
    const volumeValue = Number(source.volume ?? previous.volume);
    const volume = Number.isFinite(volumeValue) ? Math.min(1, Math.max(0, volumeValue)) : previous.volume;
    return Object.freeze({
      videoId: normalizeText(source.videoId ?? previous.videoId, MAX_VIDEO_ID_LENGTH),
      currentTime: safeCurrentTime,
      duration,
      paused: typeof source.paused === "boolean" ? source.paused : previous.paused,
      ended: typeof source.ended === "boolean" ? source.ended : previous.ended,
      buffering: typeof source.buffering === "boolean" ? source.buffering : previous.buffering,
      playbackRate: normalizePositive(source.playbackRate, previous.playbackRate),
      volume,
      muted: typeof source.muted === "boolean" ? source.muted : previous.muted,
      quality: normalizeText(source.quality ?? previous.quality, MAX_QUALITY_LENGTH),
      updatedAt: updatedAtValue,
    });
  } catch { return Object.freeze({ ...DEFAULT_STATE }); }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function resolveEventTarget(candidate) {
  try {
    if (candidate && typeof candidate.addEventListener === "function" && typeof candidate.removeEventListener === "function") return candidate;
    if (typeof globalThis.window !== "undefined" && typeof globalThis.window.addEventListener === "function") return globalThis.window;
    return null;
  } catch { return null; }
}

function createSourceId() {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
  } catch { /* Continue with a process-local identifier. */ }
  try { return `player-state-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
  catch { return `player-state-${Date.now().toString(36)}`; }
}

function statesEqual(left, right) {
  try { return Object.keys(DEFAULT_STATE).every((key) => left[key] === right[key]); }
  catch { return false; }
}

/**
 * Keep a normalized snapshot of player state, with optional cross-tab storage
 * synchronization. No media state is simulated: callers provide updates.
 */
export class PlayerStateSyncManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey ?? STORAGE_KEY, 512) || STORAGE_KEY;
      this.eventTarget = resolveEventTarget(settings.eventTarget ?? settings.window);
      this.crossTabSync = settings.crossTabSync === true || settings.syncAcrossTabs === true;
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._sourceId = createSourceId();
      this._revision = 0;
      this._isApplyingRemote = false;
      this._subscribers = new Set();
      this._state = Object.freeze({ ...DEFAULT_STATE });
      this._handleStorage = (event) => this._onStorageEvent(event);
      this._load();
      if (isRecord(settings.state) || isRecord(settings.initialState)) {
        this.update(settings.state ?? settings.initialState, { source: "initial" });
      }
      if (this.crossTabSync) this._attachStorageListener();
    } catch (error) {
      this._reportError(error);
      this.storage = null;
      this.eventTarget = null;
      this.storageKey = STORAGE_KEY;
      this.crossTabSync = false;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._sourceId = createSourceId();
      this._revision = 0;
      this._isApplyingRemote = false;
      this._subscribers = new Set();
      this._state = Object.freeze({ ...DEFAULT_STATE });
      this._handleStorage = null;
    }
  }

  /** Merge a caller-provided player state update into the current snapshot. */
  update(partial, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(partial)) return this.getState();
      const settings = isRecord(options) ? options : {};
      const next = normalizeState({ ...this._state, ...partial, updatedAt: partial.updatedAt ?? Date.now() }, this._state);
      if (statesEqual(this._state, next)) return this.getState();
      const previousState = this._state;
      this._state = next;
      this._revision += 1;
      if (settings.persist !== false && !this._isApplyingRemote) this._persist();
      this._notify(settings.source ?? "local", previousState);
      return this.getState();
    } catch (error) { this._reportError(error); return this.getState(); }
  }

  setState(state, options) { return this.update(state, options); }
  sync(state, options) { return this.update(state, options); }

  getState() {
    try { return Object.freeze({ ...this._state }); }
    catch { return Object.freeze({ ...DEFAULT_STATE }); }
  }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* Safe unsubscribe. */ } };
    } catch { return () => {}; }
  }

  reset(options = {}) {
    try {
      if (this.isDestroyed) return false;
      const previousState = this._state;
      this._state = Object.freeze({ ...DEFAULT_STATE, updatedAt: Date.now() });
      this._revision += 1;
      if (options?.persist !== false) this._persist();
      this._notify("reset", previousState);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      const previousState = this._state;
      this._state = Object.freeze({ ...DEFAULT_STATE, updatedAt: Date.now() });
      this._revision += 1;
      if (options?.persist !== false) this._persist();
      this._notify("clear", previousState);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Stop synchronization and detach listeners. */
  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._detachStorageListener();
      this.isDestroyed = true;
      this._subscribers.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.eventTarget = null;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
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
      const payload = JSON.parse(raw);
      const state = isRecord(payload) && isRecord(payload.state) ? payload.state : payload;
      if (isRecord(state)) {
        this._state = normalizeState(state, DEFAULT_STATE);
        this._revision = normalizeNonNegative(payload?.revision, 0);
      }
    } catch (error) { this._state = Object.freeze({ ...DEFAULT_STATE }); this._reportError(error); }
  }

  _persist() {
    try {
      if (this._isApplyingRemote) return false;
      const envelope = { version: 1, sourceId: this._sourceId, revision: this._revision, state: this._state };
      const serialized = JSON.stringify(envelope);
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _attachStorageListener() {
    try {
      if (!this.eventTarget || typeof this.eventTarget.addEventListener !== "function" || !this._handleStorage) return false;
      this.eventTarget.addEventListener("storage", this._handleStorage);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _detachStorageListener() {
    try {
      if (this.eventTarget && this._handleStorage && typeof this.eventTarget.removeEventListener === "function") {
        this.eventTarget.removeEventListener("storage", this._handleStorage);
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _onStorageEvent(event) {
    try {
      if (this.isDestroyed || !event || (event.key !== this.storageKey && event.key !== null)) return;
      if (typeof event.newValue !== "string" || !event.newValue) return;
      const envelope = JSON.parse(event.newValue);
      if (!isRecord(envelope)) return;
      if (envelope.sourceId && envelope.sourceId === this._sourceId) return;
      const state = isRecord(envelope.state) ? envelope.state : envelope;
      if (!isRecord(state)) return;
      const remoteRevision = normalizeNonNegative(envelope.revision, 0);
      if (envelope.sourceId && remoteRevision <= this._revision && statesEqual(this._state, normalizeState(state, this._state))) return;
      const next = normalizeState(state, this._state);
      if (statesEqual(this._state, next)) {
        this._revision = Math.max(this._revision, remoteRevision);
        return;
      }
      const previousState = this._state;
      this._isApplyingRemote = true;
      this._state = next;
      this._revision = Math.max(this._revision, remoteRevision);
      this._notify("remote", previousState);
    } catch (error) { this._reportError(error); }
    finally { this._isApplyingRemote = false; }
  }

  _notify(source, previousState) {
    try {
      const event = Object.freeze({ source, state: this.getState(), previousState: previousState ? Object.freeze({ ...previousState }) : null });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Player state synchronization failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate error handlers. */ }
    } catch { /* Error handling must not interrupt state synchronization. */ }
  }
}

/** Create a player state manager without throwing when browser APIs are absent. */
export function createPlayerStateSyncManager(options = {}) {
  try { return new PlayerStateSyncManager(options); }
  catch { return null; }
}

export default Object.freeze({ PlayerStateSyncManager, createPlayerStateSyncManager });
