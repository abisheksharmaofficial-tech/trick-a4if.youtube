const STORAGE_KEY = "trick-a4if-tube:watch-history:v1";
const memoryStorage = new Map();
const DEFAULT_HISTORY_LIMIT = 500;
const MAX_HISTORY_LIMIT = 10000;

function isRecord(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function normalizeText(value, maxLength = 2000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch {
    return "";
  }
}

function normalizeNumber(value, fallback = null) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeLimit(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.floor(number))) : DEFAULT_HISTORY_LIMIT;
  } catch {
    return DEFAULT_HISTORY_LIMIT;
  }
}

function normalizeVideoId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.videoId ?? value.id ?? value.key ?? value.url, 512);
    return normalizeText(value, 512);
  } catch {
    return "";
  }
}

function normalizeEntry(input, now = Date.now()) {
  try {
    if (!isRecord(input)) return null;
    const videoId = normalizeVideoId(input.videoId ?? input.id ?? input.key);
    if (!videoId) return null;

    const duration = normalizeNumber(input.durationSeconds ?? input.duration, 0);
    const currentTime = normalizeNumber(input.currentTimeSeconds ?? input.currentTime ?? input.position, 0);
    const safeCurrentTime = duration > 0 ? Math.min(currentTime, duration) : currentTime;
    const providedProgress = normalizeNumber(input.progress, null);
    const progress = duration > 0
      ? Math.min(1, Math.max(0, safeCurrentTime / duration))
      : (providedProgress === null ? 0 : Math.min(1, providedProgress > 1 ? providedProgress / 100 : providedProgress));
    const watchedAtValue = normalizeNumber(input.watchedAt ?? input.lastWatchedAt ?? input.updatedAt, now);

    return Object.freeze({
      videoId,
      id: videoId,
      title: normalizeText(input.title, 1000),
      category: normalizeText(input.category, 300),
      thumbnail: normalizeText(input.thumbnail ?? input.thumbnailUrl, 4096),
      channel: normalizeText(input.channel ?? input.channelName ?? input.author ?? input.uploader, 500),
      author: normalizeText(input.author ?? input.channel ?? input.channelName ?? input.uploader, 500),
      duration,
      currentTime: safeCurrentTime,
      progress,
      watchedAt: watchedAtValue,
    });
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

function freezeList(entries) {
  try {
    return Object.freeze(entries.slice());
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Maintain a bounded, most-recently-watched-first history for video records.
 * Video durations and playback positions are seconds; watchedAt is Unix epoch
 * milliseconds. Storage failures fall back to process-local memory.
 */
export class WatchHistoryManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.limit = normalizeLimit(settings.limit ?? settings.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this._entries = [];
    this._load();
  }

  /** Record or update a watched video, moving its entry to the newest position. */
  record(video, details = {}) {
    try {
      let input;
      if (isRecord(video)) {
        input = { ...video, ...(isRecord(details) ? details : {}) };
      } else {
        input = { ...(isRecord(details) ? details : {}), videoId: video };
      }
      const entry = normalizeEntry(input, Date.now());
      if (!entry || this.limit === 0) return null;
      const existingIndex = this._entries.findIndex((item) => item.videoId === entry.videoId);
      let normalized = entry;
      if (existingIndex >= 0) {
        const existing = this._entries[existingIndex];
        normalized = normalizeEntry({
          ...existing,
          ...input,
          videoId: entry.videoId,
          watchedAt: normalizeNumber(input.watchedAt, Date.now()),
        }, Date.now());
        this._entries.splice(existingIndex, 1);
      }
      if (!normalized) return null;
      this._entries.unshift(normalized);
      this._enforceLimit();
      this._persist();
      this._notifyChange("recorded", normalized);
      return normalized;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Alias for record(). */
  recordWatch(video, details = {}) {
    try {
      return this.record(video, details);
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Return history newest-first by default, with optional query filters. */
  getHistory(options = {}) {
    try {
      const settings = typeof options === "string" ? { search: options } : (isRecord(options) ? options : {});
      let results = this._entries.slice();
      const category = normalizeText(settings.category, 300).toLocaleLowerCase();
      if (category) results = results.filter((entry) => entry.category.toLocaleLowerCase() === category);

      const query = normalizeText(settings.search ?? settings.query, 1000).toLocaleLowerCase();
      if (query) {
        results = results.filter((entry) => [entry.title, entry.category, entry.channel, entry.author, entry.videoId]
          .some((value) => value.toLocaleLowerCase().includes(query)));
      }
      if (settings.videoId !== undefined || settings.id !== undefined) {
        const id = normalizeVideoId(settings.videoId ?? settings.id);
        results = results.filter((entry) => entry.videoId === id);
      }
      const since = normalizeNumber(settings.since, null);
      const before = normalizeNumber(settings.before, null);
      if (since !== null) results = results.filter((entry) => entry.watchedAt >= since);
      if (before !== null) results = results.filter((entry) => entry.watchedAt <= before);

      const sortBy = settings.sortBy ?? settings.sort ?? "recent";
      const direction = settings.order === "asc" || settings.ascending === true ? 1 : -1;
      if (sortBy === "title") {
        results.sort((left, right) => direction * left.title.localeCompare(right.title));
      } else if (sortBy === "category") {
        results.sort((left, right) => direction * left.category.localeCompare(right.category));
      } else {
        results.sort((left, right) => direction * (left.watchedAt - right.watchedAt));
      }

      const offset = Math.max(0, Math.floor(normalizeNumber(settings.offset, 0)));
      const limit = settings.limit === undefined ? results.length : normalizeLimit(settings.limit);
      return freezeList(results.slice(offset, offset + limit));
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Alias for getHistory(). */
  list(options = {}) {
    try {
      return this.getHistory(options);
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Find a history entry by video id. */
  get(videoId) {
    try {
      const id = normalizeVideoId(videoId);
      return this._entries.find((entry) => entry.videoId === id) ?? null;
    } catch {
      return null;
    }
  }

  /** Remove one entry by id; returns whether an entry was removed. */
  remove(videoId) {
    try {
      const id = normalizeVideoId(videoId);
      if (!id) return false;
      const index = this._entries.findIndex((entry) => entry.videoId === id);
      if (index < 0) return false;
      const [removed] = this._entries.splice(index, 1);
      this._persist();
      this._notifyChange("removed", removed);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for remove(). */
  removeEntry(videoId) {
    try {
      return this.remove(videoId);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Remove all history entries. */
  clear() {
    try {
      if (this._entries.length === 0) return true;
      this._entries = [];
      this._persist();
      this._notifyChange("cleared", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for clear(). */
  clearHistory() {
    try {
      return this.clear();
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Export a versioned JSON document or object. */
  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = {
        version: 1,
        exportedAt: Date.now(),
        entries: this.getHistory({ sortBy: settings.sortBy ?? "recent", order: settings.order }),
      };
      return settings.asObject === true
        ? Object.freeze(payload)
        : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Import a JSON string or payload; replace existing records only when requested. */
  importJSON(input, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { entries: payload };
      if (!isRecord(payload)) return 0;
      const records = payload.entries ?? payload.history ?? payload.items;
      if (!Array.isArray(records)) return 0;

      const byId = new Map(settings.replace === true ? [] : this._entries.map((entry) => [entry.videoId, entry]));
      let importedCount = 0;
      const now = Date.now();
      for (const candidate of records) {
        const entry = normalizeEntry(candidate, now);
        if (!entry) continue;
        const previous = byId.get(entry.videoId);
        if (!previous || entry.watchedAt >= previous.watchedAt) byId.set(entry.videoId, entry);
        importedCount += 1;
      }
      this._entries = [...byId.values()].sort((left, right) => right.watchedAt - left.watchedAt);
      this._enforceLimit();
      this._persist();
      if (importedCount > 0 || settings.replace === true) this._notifyChange("imported", null);
      return importedCount;
    } catch (error) {
      this._reportError(error);
      return 0;
    }
  }

  /** Current number of stored history records. */
  get size() {
    try {
      return this._entries.length;
    } catch {
      return 0;
    }
  }

  _enforceLimit() {
    try {
      if (this._entries.length > this.limit) this._entries.length = this.limit;
    } catch (error) {
      this._reportError(error);
    }
  }

  _load() {
    try {
      let raw = null;
      if (this.storage) raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const payload = JSON.parse(raw);
      const records = Array.isArray(payload) ? payload : payload?.entries;
      if (!Array.isArray(records)) return;
      const byId = new Map();
      for (const candidate of records) {
        const entry = normalizeEntry(candidate);
        if (!entry) continue;
        const previous = byId.get(entry.videoId);
        if (!previous || entry.watchedAt > previous.watchedAt) byId.set(entry.videoId, entry);
      }
      this._entries = [...byId.values()].sort((left, right) => right.watchedAt - left.watchedAt);
      this._enforceLimit();
    } catch (error) {
      this._entries = [];
      this._reportError(error);
    }
  }

  _persist() {
    try {
      const value = JSON.stringify({ version: 1, entries: this._entries });
      memoryStorage.set(this.storageKey, value);
      if (this.storage) {
        try {
          this.storage.setItem(this.storageKey, value);
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

  _notifyChange(type, entry) {
    try {
      if (this.onChange) this.onChange(Object.freeze({
        type,
        entry: entry ?? null,
        history: this.getHistory(),
      }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Watch history operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt history operations.
    }
  }
}

/** Create a watch history manager without throwing when browser storage is unavailable. */
export function createWatchHistoryManager(options = {}) {
  try {
    return new WatchHistoryManager(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  WatchHistoryManager,
  createWatchHistoryManager,
});
