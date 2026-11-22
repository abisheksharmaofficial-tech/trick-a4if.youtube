const STORAGE_KEY = "trick-a4if-tube:volume-audio-mixer:v1";
const DEFAULT_STEP = 0.05;
const DEFAULT_MAX_GAIN = 2;
const memoryStorage = new Map();

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, fallback = "", limit = 512) {
  try {
    if (typeof value !== "string") return fallback;
    const text = value.trim().slice(0, limit);
    return text || fallback;
  } catch {
    return fallback;
  }
}

function normalizeUnit(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeBalance(value, fallback = 0) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(-1, number)) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeGain(value, maxGain, fallback = 1) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(maxGain, number) : fallback;
  } catch {
    return fallback;
  }
}

function normalizePositive(value, fallback) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Manage normalized volume, mute state, stereo balance and optional gain.
 * Media element and storage APIs are guarded for non-DOM and restricted
 * environments. Volume and balance are applied only where supported.
 */
export class VolumeAudioMixer {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, STORAGE_KEY, 512) || STORAGE_KEY;
    this.mediaElement = settings.mediaElement ?? settings.audioElement ?? settings.videoElement ?? null;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._subscribers = new Set();

    this.stepSize = normalizePositive(settings.stepSize ?? settings.step, DEFAULT_STEP);
    const requestedMaxGain = Number(settings.maxGain ?? settings.maxBoost ?? DEFAULT_MAX_GAIN);
    this.maxGain = Number.isFinite(requestedMaxGain) && requestedMaxGain >= 1 ? requestedMaxGain : DEFAULT_MAX_GAIN;
    this.supportsBalance = settings.supportBalance === true || settings.balance !== undefined;
    this.supportsGain = settings.supportGain === true || settings.gain !== undefined || settings.boost !== undefined;

    const stored = this._load();
    const mediaVolume = this._readMediaVolume();
    this.volume = normalizeUnit(settings.volume ?? settings.initialVolume, null)
      ?? normalizeUnit(stored?.volume, null)
      ?? mediaVolume
      ?? 1;
    this.previousVolume = normalizeUnit(settings.previousVolume ?? stored?.previousVolume, null);
    if (this.previousVolume === null || this.previousVolume <= 0) this.previousVolume = this.volume > 0 ? this.volume : 1;
    this.muted = typeof settings.muted === "boolean"
      ? settings.muted
      : (typeof stored?.muted === "boolean" ? stored.muted : this._readMediaMuted());
    this.balance = normalizeBalance(settings.balance ?? stored?.balance, 0);
    this.gain = normalizeGain(settings.gain ?? settings.boost ?? stored?.gain, this.maxGain, 1);

    this._applyToMedia();
    if (settings.persistOnCreate === true) this._persist();
  }

  /** Return volume as a normalized value from 0 to 1. */
  getVolume() {
    try { return this.volume; }
    catch { return 0; }
  }

  /** Return volume as a percentage from 0 to 100. */
  getVolumePercent() {
    try { return Math.round(this.volume * 100); }
    catch { return 0; }
  }

  /** Set volume from a normalized 0-to-1 value. */
  setVolume(value) {
    try {
      if (this.isDestroyed) return false;
      const volume = normalizeUnit(value, null);
      if (volume === null) return false;
      const previousVolume = this.volume;
      if (volume > 0) this.previousVolume = volume;
      this.volume = volume;
      if (volume > 0 && this.muted) this.muted = false;
      this._applyToMedia();
      this._persist();
      if (previousVolume !== volume) this._notify("volume", { previousVolume, volume });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set volume from a 0-to-100 percentage. */
  setVolumePercent(value) {
    try {
      if (value === null || value === undefined || value === "") return false;
      const percentage = Number(value);
      if (!Number.isFinite(percentage)) return false;
      return this.setVolume(Math.min(100, Math.max(0, percentage)) / 100);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  mute() {
    try {
      if (this.isDestroyed) return false;
      if (!this.muted && this.volume > 0) this.previousVolume = this.volume;
      const changed = !this.muted;
      this.muted = true;
      this._applyToMedia();
      this._persist();
      if (changed) this._notify("mute");
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  unmute() {
    try {
      if (this.isDestroyed) return false;
      const wasMuted = this.muted;
      this.muted = false;
      if (this.volume <= 0) this.volume = this.previousVolume > 0 ? this.previousVolume : 1;
      this._applyToMedia();
      this._persist();
      if (wasMuted) this._notify("unmute");
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  toggleMute(force) {
    try {
      if (this.isDestroyed) return false;
      const shouldMute = typeof force === "boolean" ? force : !this.muted;
      return shouldMute ? this.mute() : this.unmute();
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  stepUp() {
    try {
      if (this.isDestroyed) return false;
      return this.setVolume(Math.min(1, this.volume + this.stepSize));
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  stepDown() {
    try {
      if (this.isDestroyed) return false;
      return this.setVolume(Math.max(0, this.volume - this.stepSize));
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set optional stereo balance, clamped to -1 (left) through 1 (right). */
  setBalance(value) {
    try {
      if (this.isDestroyed) return false;
      const balance = normalizeBalance(value, null);
      if (balance === null) return false;
      const previousBalance = this.balance;
      this.balance = balance;
      this.supportsBalance = true;
      this._persist();
      if (previousBalance !== balance) this._notify("balance", { previousBalance, balance });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set optional gain/boost, clamped between zero and maxGain. */
  setGain(value) {
    try {
      if (this.isDestroyed) return false;
      const gain = normalizeGain(value, this.maxGain, null);
      if (gain === null) return false;
      const previousGain = this.gain;
      this.gain = gain;
      this.supportsGain = true;
      this._persist();
      if (previousGain !== gain) this._notify("gain", { previousGain, gain });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Bind a media element and optionally apply the current volume/mute state. */
  bindMediaElement(mediaElement, options = {}) {
    try {
      if (this.isDestroyed) return false;
      this.mediaElement = mediaElement ?? null;
      const settings = isRecord(options) ? options : {};
      return settings.apply === false ? true : this._applyToMedia();
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Immutable snapshot of volume and optional audio controls. */
  getState() {
    try {
      return Object.freeze({
        volume: this.volume,
        volumePercent: this.getVolumePercent(),
        muted: this.muted,
        previousVolume: this.previousVolume,
        balance: this.balance,
        gain: this.gain,
        maxGain: this.maxGain,
        stepSize: this.stepSize,
        supportsBalance: this.supportsBalance,
        supportsGain: this.supportsGain,
        hasMediaElement: Boolean(this.mediaElement),
        isDestroyed: this.isDestroyed,
      });
    } catch {
      return null;
    }
  }

  /** Register a state subscriber; returns an unsubscribe function. */
  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => false;
      this._subscribers.add(listener);
      let active = true;
      return () => {
        try {
          if (!active) return false;
          active = false;
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

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._subscribers.clear();
      this.mediaElement = null;
      this.storage = null;
      this.onChange = null;
      this.onError = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }

  _readMediaVolume() {
    try {
      const value = Number(this.mediaElement?.volume);
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
    } catch {
      return null;
    }
  }

  _readMediaMuted() {
    try { return Boolean(this.mediaElement?.muted); }
    catch { return false; }
  }

  _applyToMedia() {
    try {
      const media = this.mediaElement;
      if (!media || typeof media !== "object") return false;
      let applied = false;
      if ("volume" in media) {
        try {
          media.volume = this.volume;
          applied = true;
        } catch (error) {
          this._reportError(error);
        }
      }
      if ("muted" in media) {
        try {
          media.muted = this.muted;
          applied = true;
        } catch (error) {
          this._reportError(error);
        }
      }
      return applied;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _load() {
    try {
      let serialized = null;
      try { serialized = this.storage?.getItem(this.storageKey) ?? null; }
      catch (error) { this._reportError(error); }
      if (typeof serialized !== "string" || !serialized) serialized = memoryStorage.get(this.storageKey) ?? null;
      if (typeof serialized !== "string" || !serialized) return null;
      const parsed = JSON.parse(serialized);
      return isRecord(parsed) ? parsed : null;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({
        version: 1,
        volume: this.volume,
        muted: this.muted,
        previousVolume: this.previousVolume,
        balance: this.balance,
        gain: this.gain,
      });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _notify(reason, detail = {}) {
    try {
      const event = Object.freeze({ type: "statechange", reason, ...detail, state: this.getState() });
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
      this.lastError = error instanceof Error ? error : new Error("Volume audio mixer operation failed.");
      try { this.onError?.(this.lastError, this); }
      catch { /* Error callbacks must not escape mixer operations. */ }
    } catch {
      // Error reporting must not interrupt volume operations or teardown.
    }
  }
}

/** Create a volume audio mixer without throwing on initialization failures. */
export function createVolumeAudioMixer(options = {}) {
  try { return new VolumeAudioMixer(options); }
  catch { return null; }
}

export function toVolumePercent(volume) {
  try {
    const normalized = normalizeUnit(volume, null);
    return normalized === null ? 0 : Math.round(normalized * 100);
  } catch {
    return 0;
  }
}

export function fromVolumePercent(percentage) {
  try {
    const value = Number(percentage);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : 0;
  } catch {
    return 0;
  }
}

export default Object.freeze({
  VolumeAudioMixer,
  createVolumeAudioMixer,
  toVolumePercent,
  fromVolumePercent,
});
