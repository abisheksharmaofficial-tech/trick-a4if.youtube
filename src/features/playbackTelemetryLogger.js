const STORAGE_KEY = "trick-a4if-tube:playback-telemetry:v1";
const DEFAULT_MAX_ENTRIES = 1000;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_VIDEO_ID_LENGTH = 512;
const MAX_METADATA_DEPTH = 8;
const memoryStorage = new Map();
const PROGRESS_TYPES = new Set(["timeupdate", "time-update", "progress", "position", "playback-progress"]);
const ERROR_TYPES = new Set(["error", "playback-error", "player-error"]);
const BUFFERED_TYPES = new Set(["buffered", "buffering", "waiting", "stalled"]);

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, fallback = "", maxLength = 512) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return fallback;
    const result = String(value).trim().slice(0, maxLength);
    return result || fallback;
  } catch {
    return fallback;
  }
}

function normalizeNonNegative(value, fallback = null) {
  try {
    if (value === "" || value === null || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTimestamp(value) {
  try {
    if (value === undefined || value === null) return Date.now();
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  } catch {
    return null;
  }
}

function normalizeMaxEntries(value, fallback = DEFAULT_MAX_ENTRIES) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  } catch {
    return fallback;
  }
}

function cloneMetadata(value, depth = 0, seen = new WeakSet()) {
  try {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "object" || depth >= MAX_METADATA_DEPTH) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      const result = value.map((entry) => cloneMetadata(entry, depth + 1, seen)).filter((entry) => entry !== undefined);
      seen.delete(value);
      return result;
    }

    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "undefined") continue;
      const cloned = cloneMetadata(entry, depth + 1, seen);
      if (cloned !== undefined) result[key] = cloned;
    }
    seen.delete(value);
    return result;
  } catch {
    return undefined;
  }
}

function normalizeEvent(input) {
  try {
    if (!isRecord(input)) return null;
    const type = normalizeText(input.type ?? input.eventType, "", MAX_EVENT_TYPE_LENGTH);
    const timestamp = normalizeTimestamp(input.timestamp ?? input.time);
    if (!type || timestamp === null) return null;

    const metadata = cloneMetadata(input.metadata ?? {});
    const event = {
      type,
      videoId: normalizeText(input.videoId ?? input.video_id, "", MAX_VIDEO_ID_LENGTH) || null,
      timestamp,
      position: normalizeNonNegative(input.position ?? input.currentTime),
      duration: normalizeNonNegative(input.duration),
      metadata: isRecord(metadata) ? metadata : {},
      watchDurationDeltaSeconds: normalizeNonNegative(input.watchDurationDeltaSeconds, 0),
    };
    return Object.freeze(event);
  } catch {
    return null;
  }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") {
      return candidate;
    }
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function matchesFilter(event, filter) {
  try {
    if (!isRecord(filter)) return true;
    if (filter.type !== undefined) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!types.map((value) => normalizeText(value).toLowerCase()).includes(event.type.toLowerCase())) return false;
    }
    if (filter.videoId !== undefined && event.videoId !== normalizeText(filter.videoId, "", MAX_VIDEO_ID_LENGTH)) return false;
    const from = normalizeNonNegative(filter.from ?? filter.startTime);
    const to = normalizeNonNegative(filter.to ?? filter.endTime);
    if (from !== null && event.timestamp < from) return false;
    if (to !== null && event.timestamp > to) return false;
    if (filter.since !== undefined) {
      const since = normalizeNonNegative(filter.since);
      if (since !== null && event.timestamp < since) return false;
    }
    if (filter.until !== undefined) {
      const until = normalizeNonNegative(filter.until);
      if (until !== null && event.timestamp > until) return false;
    }
    if (typeof filter.predicate === "function" && !filter.predicate(event)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Record structured playback/player telemetry in a bounded in-memory buffer.
 * When storage is available, the buffer is persisted locally; otherwise a
 * process-local memory store is used. No playback or network activity is
 * generated by this logger.
 */
export class PlaybackTelemetryLogger {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, STORAGE_KEY, 512) || STORAGE_KEY;
    this.maxEntries = normalizeMaxEntries(settings.maxEntries ?? settings.maxEvents);
    this.onEvent = typeof settings.onEvent === "function" ? settings.onEvent : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._events = [];
    this._listeners = new Set();
    this._lastPositionByVideo = new Map();
    this._load();
  }

  /** Record an event object. Returns its immutable normalized entry, or false. */
  record(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const source = typeof input === "string"
        ? { ...(isRecord(options) ? options : {}), type: input }
        : input;
      const normalized = normalizeEvent(source);
      if (!normalized) return false;

      const delta = this._resolveWatchDelta(normalized, source);
      const event = Object.freeze({ ...normalized, watchDurationDeltaSeconds: delta });
      this._append(event);
      this._persist();
      this._notify(event);
      return event;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for record(). */
  logEvent(event, options) {
    try { return this.record(event, options); }
    catch (error) { this._reportError(error); return false; }
  }

  /** Query retained events with optional type, video, timestamp, and predicate filters. */
  query(filter = {}) {
    try {
      if (this.isDestroyed) return Object.freeze([]);
      const settings = isRecord(filter) ? filter : {};
      let events = this._events.filter((event) => matchesFilter(event, settings));
      if (settings.order === "desc" || settings.descending === true) events.reverse();
      const offset = normalizeMaxEntries(settings.offset, 0);
      if (offset > 0) events = events.slice(offset);
      if (settings.limit !== undefined) events = events.slice(0, normalizeMaxEntries(settings.limit, events.length));
      return Object.freeze(events.slice());
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Alias for query(). */
  getEvents(filter = {}) {
    try { return this.query(filter); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  /** Summarize retained events, type counts, buffering/errors, and watch deltas. */
  getSummary(filter = {}) {
    try {
      const events = this.query(filter);
      const countsByType = Object.create(null);
      let bufferedEvents = 0;
      let errorEvents = 0;
      let watchDurationSeconds = 0;
      const videoIds = new Set();

      for (const event of events) {
        const type = event.type.toLowerCase();
        countsByType[event.type] = (countsByType[event.type] ?? 0) + 1;
        if (BUFFERED_TYPES.has(type)) bufferedEvents += 1;
        if (ERROR_TYPES.has(type)) errorEvents += 1;
        watchDurationSeconds += event.watchDurationDeltaSeconds;
        if (event.videoId) videoIds.add(event.videoId);
      }

      return Object.freeze({
        totalEvents: events.length,
        countsByType: Object.freeze({ ...countsByType }),
        bufferedEvents,
        errorEvents,
        watchDurationSeconds,
        videoCount: videoIds.size,
        firstTimestamp: events.length ? events[0].timestamp : null,
        lastTimestamp: events.length ? events[events.length - 1].timestamp : null,
        maxEntries: this.maxEntries,
      });
    } catch (error) {
      this._reportError(error);
      return Object.freeze({
        totalEvents: 0,
        countsByType: Object.freeze({}),
        bufferedEvents: 0,
        errorEvents: 0,
        watchDurationSeconds: 0,
        videoCount: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        maxEntries: this.maxEntries,
      });
    }
  }

  /** Alias for getSummary(). */
  summary(filter = {}) {
    try { return this.getSummary(filter); }
    catch (error) { this._reportError(error); return null; }
  }

  /** Export retained data as an immutable object or JSON string. */
  exportData(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = {
        version: 1,
        maxEntries: this.maxEntries,
        events: this._events.slice(),
      };
      return settings.asObject === true
        ? Object.freeze({ ...payload, events: Object.freeze(payload.events) })
        : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Import an export payload. Replace is the default; merge deduplicates exact events. */
  importData(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (!isRecord(payload) || !Array.isArray(payload.events)) return false;

      const imported = payload.events.map(normalizeEvent).filter(Boolean);
      if (settings.replace === false) {
        const existingKeys = new Set(this._events.map((event) => this._eventKey(event)));
        for (const event of imported) {
          const key = this._eventKey(event);
          if (!existingKeys.has(key)) {
            this._append(event);
            existingKeys.add(key);
          }
        }
      } else {
        this._events = [];
        for (const event of imported) this._append(event);
      }

      if (settings.maxEntries !== undefined || payload.maxEntries !== undefined) {
        this.maxEntries = normalizeMaxEntries(settings.maxEntries ?? payload.maxEntries, this.maxEntries);
        this._trim();
      }
      this._rebuildPositions();
      this._persist();
      this._notify(Object.freeze({ type: "import", count: imported.length, summary: this.getSummary() }));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for importData(). */
  importJSON(input, options) {
    try { return this.importData(input, options); }
    catch (error) { this._reportError(error); return false; }
  }

  /** Remove all retained events and persist the empty collection. */
  clear() {
    try {
      if (this.isDestroyed) return false;
      const removed = this._events.length;
      this._events = [];
      this._lastPositionByVideo.clear();
      this._persist();
      this._notify(Object.freeze({ type: "clear", removed, summary: this.getSummary() }));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Subscribe to new event, import, and clear notifications; returns unsubscribe. */
  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => false;
      this._listeners.add(listener);
      let active = true;
      return () => {
        try {
          if (!active) return false;
          active = false;
          return this._listeners.delete(listener);
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
    try { return this._listeners.delete(listener); }
    catch (error) { this._reportError(error); return false; }
  }

  /** Set retention capacity and immediately discard oldest entries as needed. */
  setMaxEntries(value) {
    try {
      if (this.isDestroyed) return false;
      const capacity = normalizeMaxEntries(value, -1);
      if (capacity < 0) return false;
      this.maxEntries = capacity;
      this._trim();
      this._rebuildPositions();
      this._persist();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._listeners.clear();
      this.onEvent = null;
      this.onError = null;
      this.storage = null;
      this._lastPositionByVideo.clear();
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }

  _resolveWatchDelta(event, source) {
    try {
      const explicit = normalizeNonNegative(source.watchDurationDeltaSeconds, null);
      if (explicit !== null) return explicit;
      const type = event.type.toLowerCase();
      if (!event.videoId || event.position === null || !PROGRESS_TYPES.has(type)) return 0;

      const previous = this._lastPositionByVideo.get(event.videoId);
      this._lastPositionByVideo.set(event.videoId, { position: event.position, timestamp: event.timestamp });
      if (!previous || event.timestamp < previous.timestamp || event.position <= previous.position) return 0;

      const positionDelta = event.position - previous.position;
      const elapsedSeconds = (event.timestamp - previous.timestamp) / 1000;
      // Position jumps (for example seeking) do not count as watch duration.
      return elapsedSeconds > 0 ? Math.min(positionDelta, elapsedSeconds) : 0;
    } catch {
      return 0;
    }
  }

  _append(event) {
    try {
      if (this.maxEntries === 0) return;
      this._events.push(event);
      this._trim();
    } catch (error) {
      this._reportError(error);
    }
  }

  _trim() {
    try {
      if (this.maxEntries === 0) {
        this._events = [];
      } else if (this._events.length > this.maxEntries) {
        this._events.splice(0, this._events.length - this.maxEntries);
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _eventKey(event) {
    try {
      return `${event.timestamp}|${event.type}|${event.videoId ?? ""}|${event.position ?? ""}|${JSON.stringify(event.metadata)}`;
    } catch {
      return `${event.timestamp}|${event.type}|${event.videoId ?? ""}`;
    }
  }

  _rebuildPositions() {
    try {
      this._lastPositionByVideo.clear();
      for (const event of this._events) {
        if (event.videoId && event.position !== null && PROGRESS_TYPES.has(event.type.toLowerCase())) {
          this._lastPositionByVideo.set(event.videoId, { position: event.position, timestamp: event.timestamp });
        }
      }
    } catch (error) {
      this._reportError(error);
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
      if (typeof serialized !== "string" || !serialized) return false;

      const payload = JSON.parse(serialized);
      if (!isRecord(payload) || !Array.isArray(payload.events)) return false;
      this.maxEntries = normalizeMaxEntries(payload.maxEntries, this.maxEntries);
      this._events = payload.events.map(normalizeEvent).filter(Boolean);
      this._trim();
      this._rebuildPositions();
      return true;
    } catch (error) {
      this._reportError(error);
      this._events = [];
      return false;
    }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, maxEntries: this.maxEntries, events: this._events });
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

  _notify(detail) {
    try {
      try { this.onEvent?.(detail, this); }
      catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(detail, this); }
        catch (error) { this._reportError(error); }
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Playback telemetry operation failed.");
      try { this.onError?.(this.lastError, this); }
      catch { /* Error callbacks must not escape logger operations. */ }
    } catch {
      // Error reporting must not interrupt logging or cleanup.
    }
  }
}

/** Create a playback telemetry logger without throwing on initialization errors. */
export function createPlaybackTelemetryLogger(options = {}) {
  try { return new PlaybackTelemetryLogger(options); }
  catch { return null; }
}

export default Object.freeze({
  PlaybackTelemetryLogger,
  createPlaybackTelemetryLogger,
});
