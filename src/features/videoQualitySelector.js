const STORAGE_KEY = "trick-a4if-tube:video-quality-selector:v1";
const AUTO_QUALITY = "auto";
const STANDARD_QUALITIES = Object.freeze([
  Object.freeze({ id: "144p", label: "144p", height: 144 }),
  Object.freeze({ id: "240p", label: "240p", height: 240 }),
  Object.freeze({ id: "360p", label: "360p", height: 360 }),
  Object.freeze({ id: "480p", label: "480p", height: 480 }),
  Object.freeze({ id: "720p", label: "720p", height: 720 }),
  Object.freeze({ id: "1080p", label: "1080p", height: 1080 }),
  Object.freeze({ id: "1440p", label: "1440p", height: 1440 }),
  Object.freeze({ id: "2160p", label: "2160p", height: 2160 }),
]);
const NETWORK_HINTS = Object.freeze(["offline", "poor", "moderate", "good"]);
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
    if (typeof value !== "string" && typeof value !== "number") return fallback;
    const text = String(value).trim().slice(0, limit);
    return text || fallback;
  } catch {
    return fallback;
  }
}

function normalizeHeight(value) {
  try {
    const height = Number(value);
    return Number.isFinite(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

function normalizeBitrate(value) {
  try {
    const bitrate = Number(value);
    return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null;
  } catch {
    return null;
  }
}

function normalizeTrack(input) {
  try {
    const raw = typeof input === "string" || typeof input === "number" ? { id: input } : input;
    if (!isRecord(raw)) return null;
    const id = normalizeText(raw.id ?? raw.quality ?? raw.label ?? raw.height, "", 128).toLowerCase();
    if (!id || id === AUTO_QUALITY) return null;
    const height = normalizeHeight(raw.height ?? raw.resolution);
    const bitrate = normalizeBitrate(raw.bitrate ?? raw.bandwidth);
    const label = normalizeText(raw.label, height ? `${height}p` : id, 128);
    return Object.freeze({ id, label, height, bitrate, metadata: isRecord(raw.metadata) ? Object.freeze({ ...raw.metadata }) : null });
  } catch {
    return null;
  }
}

function normalizeTracks(input) {
  try {
    const candidates = Array.isArray(input) ? input : STANDARD_QUALITIES;
    const tracks = new Map();
    for (const candidate of candidates) {
      const track = normalizeTrack(candidate);
      if (track) tracks.set(track.id, track);
    }
    return [...tracks.values()].sort((left, right) => {
      if (left.height !== null && right.height !== null) return left.height - right.height || left.id.localeCompare(right.id);
      if (left.height !== null) return -1;
      if (right.height !== null) return 1;
      if (left.bitrate !== null && right.bitrate !== null) return left.bitrate - right.bitrate || left.id.localeCompare(right.id);
      if (left.bitrate !== null) return -1;
      if (right.bitrate !== null) return 1;
      return left.id.localeCompare(right.id);
    });
  } catch {
    return [];
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

function normalizeNetworkHint(input) {
  try {
    const value = typeof input === "string" ? input : (input?.quality ?? input?.network ?? input?.connectionType ?? input?.effectiveType);
    const hint = normalizeText(value, "", 32).toLowerCase();
    if (NETWORK_HINTS.includes(hint)) return hint;
    if (hint === "slow-2g" || hint === "2g") return "poor";
    if (hint === "3g") return "moderate";
    if (hint === "4g" || hint === "5g") return "good";
    const bandwidth = normalizeBitrate(input?.bandwidthMbps ?? input?.downlinkMbps);
    if (bandwidth !== null) {
      if (bandwidth < 1) return "poor";
      if (bandwidth < 5) return "moderate";
      return "good";
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Select a preferred video quality and resolve an effective level from caller-
 * supplied network hints. This class does not probe or simulate connectivity.
 */
export class VideoQualitySelector {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, STORAGE_KEY, 512) || STORAGE_KEY;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._subscribers = new Set();

    this.tracks = normalizeTracks(settings.availableQualities ?? settings.qualities ?? settings.tracks);
    this._trackMap = new Map(this.tracks.map((track) => [track.id, track]));
    this._trackMap.set(AUTO_QUALITY, Object.freeze({ id: AUTO_QUALITY, label: "Auto", height: null, bitrate: null, metadata: null }));

    const stored = this._load();
    const initialQuality = normalizeText(settings.quality ?? stored?.quality, AUTO_QUALITY, 128).toLowerCase();
    this.autoMode = typeof settings.autoMode === "boolean"
      ? settings.autoMode
      : (typeof stored?.autoMode === "boolean" ? stored.autoMode : initialQuality === AUTO_QUALITY);
    this.quality = this.autoMode || !this._trackMap.has(initialQuality) ? AUTO_QUALITY : initialQuality;
    this.networkHint = normalizeNetworkHint(settings.networkHint ?? settings.network ?? settings.bandwidthHint);
    if (settings.persistOnCreate === true) this._persist();
  }

  /** Choose a specific available quality, or "auto" to enable automatic mode. */
  setQuality(quality) {
    try {
      if (this.isDestroyed) return false;
      const requested = normalizeText(quality, "", 128).toLowerCase();
      if (requested === AUTO_QUALITY) return this.setAutoMode(true);
      if (!requested || !this._trackMap.has(requested)) return false;
      const previous = this.quality;
      const previousAutoMode = this.autoMode;
      this.quality = requested;
      this.autoMode = false;
      this._persist();
      if (previous !== requested || previousAutoMode) this._notify("quality", { previousQuality: previous, quality: requested });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Enable or disable adaptive quality selection. */
  setAutoMode(enabled) {
    try {
      if (this.isDestroyed) return false;
      const next = Boolean(enabled);
      const previousQuality = this.quality;
      const previousAutoMode = this.autoMode;
      if (next) {
        this.autoMode = true;
        this.quality = AUTO_QUALITY;
      } else {
        this.autoMode = false;
        if (this.quality === AUTO_QUALITY) this.quality = this._lowestTrack()?.id ?? AUTO_QUALITY;
      }
      this._persist();
      if (previousAutoMode !== this.autoMode || previousQuality !== this.quality) {
        this._notify("auto-mode", { previousQuality, previousAutoMode });
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Update the network hint supplied by the caller; null clears the hint. */
  setNetworkHint(hint) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeNetworkHint(hint);
      if (hint != null && normalized === null) return false;
      const previousHint = this.networkHint;
      this.networkHint = normalized;
      if (previousHint !== normalized) this._notify("network-hint", { previousHint, networkHint: normalized });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Return the selected level, or an adaptive level if auto mode is enabled. */
  getEffectiveQuality(hint = this.networkHint) {
    try {
      if (!this.autoMode) return this._trackMap.get(this.quality) ?? null;
      const network = normalizeNetworkHint(hint);
      if (network === "offline") return null;
      const tracks = this.tracks;
      if (!tracks.length) return null;
      if (network === "poor") return tracks[0];
      if (network === "moderate") return tracks[Math.floor((tracks.length - 1) / 2)];
      if (network === "good") return tracks[tracks.length - 1];
      return this._trackMap.get(AUTO_QUALITY);
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Return a frozen state snapshot, including available non-auto tracks. */
  getState() {
    try {
      return Object.freeze({
        quality: this.quality,
        selectedQuality: this.quality,
        autoMode: this.autoMode,
        networkHint: this.networkHint,
        effectiveQuality: this.getEffectiveQuality(),
        availableQualities: Object.freeze([this._trackMap.get(AUTO_QUALITY), ...this.tracks]),
        isDestroyed: this.isDestroyed,
      });
    } catch {
      return null;
    }
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
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

  addEventListener(type, listener) {
    try {
      if (type !== "change" && type !== "statechange") return false;
      if (this.isDestroyed || typeof listener !== "function") return false;
      this._subscribers.add(listener);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  removeEventListener(type, listener) {
    try {
      return type === "change" || type === "statechange" ? this._subscribers.delete(listener) : false;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Replace the available track list, retaining the selected quality if valid. */
  setAvailableQualities(qualities) {
    try {
      if (this.isDestroyed || !Array.isArray(qualities)) return false;
      const tracks = normalizeTracks(qualities);
      const map = new Map(tracks.map((track) => [track.id, track]));
      map.set(AUTO_QUALITY, Object.freeze({ id: AUTO_QUALITY, label: "Auto", height: null, bitrate: null, metadata: null }));
      const previousQuality = this.quality;
      this.tracks = tracks;
      this._trackMap = map;
      if (!this.autoMode && !map.has(this.quality)) {
        this.quality = tracks[0]?.id ?? AUTO_QUALITY;
        this.autoMode = this.quality === AUTO_QUALITY;
        this._persist();
      }
      this._notify("available-qualities", { previousQuality });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._subscribers.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }

  _lowestTrack() {
    try { return this.tracks[0] ?? null; }
    catch { return null; }
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
      const serialized = JSON.stringify({ version: 1, quality: this.quality, autoMode: this.autoMode });
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
      this.lastError = error instanceof Error ? error : new Error("Video quality selector operation failed.");
      try { this.onError?.(this.lastError, this); }
      catch { /* Error callbacks must not escape selector operations. */ }
    } catch {
      // Error reporting must not interrupt quality selection or teardown.
    }
  }
}

/** Create a video quality selector without throwing on initialization failures. */
export function createVideoQualitySelector(options = {}) {
  try { return new VideoQualitySelector(options); }
  catch { return null; }
}

export const VIDEO_QUALITY_AUTO = AUTO_QUALITY;
export const VIDEO_STANDARD_QUALITIES = STANDARD_QUALITIES;

export default Object.freeze({
  VIDEO_QUALITY_AUTO,
  VIDEO_STANDARD_QUALITIES,
  VideoQualitySelector,
  createVideoQualitySelector,
});
