const STORAGE_KEY = "trick-a4if-tube:timestamp-bookmarks:v1";
const memoryStorage = new Map();
const DEFAULT_MAX_BOOKMARKS = 10000;
const MAX_BOOKMARKS = 50000;
const MAX_TAGS = 100;

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

function normalizeText(value, maxLength = 4000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.videoId ?? value.id ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeNumber(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    const number = normalizeNumber(value, null);
    if (number !== null) return number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
}

function normalizeTags(value) {
  try {
    const candidates = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    const seen = new Set();
    const tags = [];
    for (const candidate of candidates) {
      const tag = normalizeText(candidate, 128);
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
    return Object.freeze(tags);
  } catch { return Object.freeze([]); }
}

function normalizeBookmark(input, defaults = {}) {
  try {
    if (!isRecord(input)) return null;
    const videoId = normalizeId(input.videoId ?? input.video ?? defaults.videoId);
    const timeSeconds = normalizeNumber(input.timeSeconds ?? input.position ?? input.time, null);
    if (!videoId || timeSeconds === null) return null;
    const now = defaults.now ?? Date.now();
    const createdAt = normalizeTimestamp(input.createdAt, now);
    return Object.freeze({
      id: normalizeText(input.id ?? input.bookmarkId, 512) || defaults.createId?.() || "",
      videoId,
      timeSeconds,
      label: normalizeText(input.label ?? input.title, 512),
      note: normalizeText(input.note ?? input.description, 4000),
      tags: normalizeTags(input.tags),
      createdAt,
      updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    });
  } catch { return null; }
}

function normalizeLimit(value) {
  try {
    const limit = Number(value);
    return Number.isFinite(limit) ? Math.min(MAX_BOOKMARKS, Math.max(0, Math.floor(limit))) : DEFAULT_MAX_BOOKMARKS;
  } catch { return DEFAULT_MAX_BOOKMARKS; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function freezeList(values) {
  try { return Object.freeze(values.slice()); }
  catch { return Object.freeze([]); }
}

function normalizeQuery(value) {
  try { return normalizeText(value, 1000).toLocaleLowerCase(); }
  catch { return ""; }
}

/**
 * Store timestamp bookmarks for videos in seconds. Bookmarks are local data;
 * this manager never fetches or simulates playback or video information.
 */
export class BookmarkTimestampManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.videoId = normalizeId(settings.videoId ?? settings.video);
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxBookmarks = normalizeLimit(settings.maxBookmarks ?? settings.limit);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._idCounter = 0;
      this._bookmarks = [];
      this._subscribers = new Set();
      this._load();
      if (Array.isArray(settings.bookmarks) && this._bookmarks.length === 0) {
        this.importJSON(settings.bookmarks, { replace: true, silent: true });
      }
    } catch {
      this.videoId = "";
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxBookmarks = DEFAULT_MAX_BOOKMARKS;
      this.onChange = null;
      this.onError = null;
      this.lastError = null;
      this.isDestroyed = false;
      this._idCounter = 0;
      this._bookmarks = [];
      this._subscribers = new Set();
    }
  }

  createBookmark(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxBookmarks === 0) return null;
      let source = input;
      if (!isRecord(input)) source = { ...(isRecord(options) ? options : {}), timeSeconds: input };
      const settings = isRecord(options) ? options : {};
      const bookmark = normalizeBookmark({ ...source, videoId: source.videoId ?? this.videoId }, {
        videoId: this.videoId,
        createId: () => this._createId(),
      });
      if (!bookmark) return null;
      if (this._bookmarks.some((entry) => entry.id === bookmark.id)) return null;
      this._bookmarks.push(bookmark);
      this._sort();
      this._enforceLimit();
      this._persist();
      if (settings.silent !== true) this._notify("created", bookmark);
      return bookmark;
    } catch (error) { this._reportError(error); return null; }
  }

  addBookmark(input, options = {}) { return this.createBookmark(input, options); }
  add(input, options = {}) { return this.createBookmark(input, options); }

  updateBookmark(id, changes = {}, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(changes)) return null;
      const normalizedId = normalizeId(id);
      const index = this._bookmarks.findIndex((bookmark) => bookmark.id === normalizedId);
      if (!normalizedId || index < 0) return null;
      const previous = this._bookmarks[index];
      const input = { ...previous, ...changes, id: previous.id, videoId: previous.videoId, updatedAt: Date.now() };
      const bookmark = normalizeBookmark(input, { videoId: this.videoId, createId: () => this._createId() });
      if (!bookmark) return null;
      this._bookmarks[index] = bookmark;
      this._sort();
      this._persist();
      if (options?.silent !== true) this._notify("updated", bookmark);
      return bookmark;
    } catch (error) { this._reportError(error); return null; }
  }

  update(id, changes, options) { return this.updateBookmark(id, changes, options); }

  deleteBookmark(id, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const normalizedId = normalizeId(id);
      const index = this._bookmarks.findIndex((bookmark) => bookmark.id === normalizedId);
      if (!normalizedId || index < 0) return false;
      const [removed] = this._bookmarks.splice(index, 1);
      this._persist();
      if (options?.silent !== true) this._notify("deleted", removed);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeBookmark(id, options) { return this.deleteBookmark(id, options); }
  remove(id, options) { return this.deleteBookmark(id, options); }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (!this._bookmarks.length) return true;
      this._bookmarks = [];
      this._persist();
      if (options?.silent !== true) this._notify("cleared", null);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clearBookmarks(options) { return this.clear(options); }

  /** Return chronologically sorted bookmarks with optional filters/search. */
  getBookmarks(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let results = this._bookmarks.slice();
      const videoId = normalizeId(settings.videoId ?? settings.video);
      if (videoId) results = results.filter((bookmark) => bookmark.videoId === videoId);
      const query = normalizeQuery(settings.search ?? settings.query);
      if (query) results = results.filter((bookmark) => [bookmark.videoId, bookmark.label, bookmark.note, ...bookmark.tags]
        .some((value) => normalizeQuery(value).includes(query)));
      const tag = normalizeQuery(settings.tag);
      if (tag) results = results.filter((bookmark) => bookmark.tags.some((value) => normalizeQuery(value) === tag));
      const minTime = normalizeNumber(settings.minTimeSeconds ?? settings.minTime, null);
      const maxTime = normalizeNumber(settings.maxTimeSeconds ?? settings.maxTime, null);
      if (minTime !== null) results = results.filter((bookmark) => bookmark.timeSeconds >= minTime);
      if (maxTime !== null) results = results.filter((bookmark) => bookmark.timeSeconds <= maxTime);
      const createdAfter = normalizeNumber(settings.createdAfter, null);
      const createdBefore = normalizeNumber(settings.createdBefore, null);
      if (createdAfter !== null) results = results.filter((bookmark) => bookmark.createdAt >= createdAfter);
      if (createdBefore !== null) results = results.filter((bookmark) => bookmark.createdAt <= createdBefore);
      if (typeof settings.predicate === "function") results = results.filter((bookmark) => settings.predicate(bookmark));
      const direction = settings.order === "desc" || settings.ascending === false ? -1 : 1;
      results.sort((left, right) => direction * (left.timeSeconds - right.timeSeconds) || left.createdAt - right.createdAt);
      const offset = normalizeLimit(settings.offset ?? 0);
      const limit = settings.limit === undefined ? results.length : normalizeLimit(settings.limit);
      return freezeList(results.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  list(options = {}) { return this.getBookmarks(options); }
  search(query, options = {}) { return this.getBookmarks({ ...(isRecord(options) ? options : {}), search: query }); }
  get(id) {
    try { const normalized = normalizeId(id); return this._bookmarks.find((bookmark) => bookmark.id === normalized) ?? null; }
    catch { return null; }
  }

  findNearest(timeSeconds, options = {}) {
    try {
      const time = normalizeNumber(timeSeconds, null);
      if (time === null) return null;
      const candidates = this.getBookmarks(options);
      if (!candidates.length) return null;
      return candidates.reduce((nearest, bookmark) => {
        const distance = Math.abs(bookmark.timeSeconds - time);
        const nearestDistance = Math.abs(nearest.timeSeconds - time);
        return distance < nearestDistance || (distance === nearestDistance && bookmark.timeSeconds < nearest.timeSeconds) ? bookmark : nearest;
      });
    } catch (error) { this._reportError(error); return null; }
  }

  getNearestBookmark(timeSeconds, options) { return this.findNearest(timeSeconds, options); }

  getNextBookmark(timeSeconds, options = {}) {
    try {
      const time = normalizeNumber(timeSeconds, null);
      if (time === null) return null;
      return this.getBookmarks({ ...options, order: "asc" }).find((bookmark) => bookmark.timeSeconds > time) ?? null;
    } catch (error) { this._reportError(error); return null; }
  }

  getPreviousBookmark(timeSeconds, options = {}) {
    try {
      const time = normalizeNumber(timeSeconds, null);
      if (time === null) return null;
      return this.getBookmarks({ ...options, order: "desc" }).find((bookmark) => bookmark.timeSeconds < time) ?? null;
    } catch (error) { this._reportError(error); return null; }
  }

  next(timeSeconds, options) { return this.getNextBookmark(timeSeconds, options); }
  previous(timeSeconds, options) { return this.getPreviousBookmark(timeSeconds, options); }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 1, exportedAt: Date.now(), bookmarks: this.getBookmarks({ order: settings.order ?? "asc" }) };
      return settings.asObject === true ? Object.freeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { bookmarks: payload };
      if (!isRecord(payload)) return 0;
      const records = payload.bookmarks ?? payload.entries ?? payload.items;
      if (!Array.isArray(records)) return 0;
      const byId = new Map(settings.replace === true ? [] : this._bookmarks.map((bookmark) => [bookmark.id, bookmark]));
      let imported = 0;
      for (const candidate of records) {
        const bookmark = normalizeBookmark(candidate, { videoId: this.videoId, createId: () => this._createId() });
        if (!bookmark) continue;
        byId.set(bookmark.id, bookmark);
        imported += 1;
      }
      this._bookmarks = [...byId.values()].sort((a, b) => a.timeSeconds - b.timeSeconds || a.createdAt - b.createdAt)
        .slice(0, this.maxBookmarks);
      this._persist();
      if (settings.silent !== true && (imported > 0 || settings.replace === true)) this._notify("imported", null);
      return imported;
    } catch (error) { this._reportError(error); return 0; }
  }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* Safe unsubscribe. */ } };
    } catch { return () => {}; }
  }

  get size() { try { return this._bookmarks.length; } catch { return 0; } }

  destroy() {
    try { this.isDestroyed = true; this._subscribers.clear(); return true; }
    catch { return false; }
  }

  _sort() {
    try { this._bookmarks.sort((a, b) => a.timeSeconds - b.timeSeconds || a.createdAt - b.createdAt); }
    catch (error) { this._reportError(error); }
  }

  _enforceLimit() {
    try { if (this._bookmarks.length > this.maxBookmarks) this._bookmarks.length = this.maxBookmarks; }
    catch (error) { this._reportError(error); }
  }

  _createId() {
    try {
      const randomUUID = globalThis.crypto?.randomUUID;
      if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
    } catch { /* Fall back to an instance-local counter. */ }
    this._idCounter += 1;
    return `bookmark-${Date.now().toString(36)}-${this._idCounter.toString(36)}`;
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
      const records = Array.isArray(payload) ? payload : payload?.bookmarks;
      if (!Array.isArray(records)) return;
      const byId = new Map();
      for (const candidate of records) {
        const bookmark = normalizeBookmark(candidate, { videoId: this.videoId, createId: () => this._createId() });
        if (bookmark) byId.set(bookmark.id, bookmark);
      }
      this._bookmarks = [...byId.values()].sort((a, b) => a.timeSeconds - b.timeSeconds || a.createdAt - b.createdAt).slice(0, this.maxBookmarks);
    } catch (error) { this._bookmarks = []; this._reportError(error); }
  }

  _persist() {
    try {
      const value = JSON.stringify({ version: 1, bookmarks: this._bookmarks });
      memoryStorage.set(this.storageKey, value);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, value); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, bookmark) {
    try {
      const event = Object.freeze({ type, bookmark: bookmark ?? null, bookmarks: this.getBookmarks() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Bookmark timestamp operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callbacks. */ }
    } catch { /* Error handling must not interrupt bookmark operations. */ }
  }
}

/** Create a timestamp bookmark manager without throwing if setup fails. */
export function createBookmarkTimestampManager(options = {}) {
  try { return new BookmarkTimestampManager(options); }
  catch { return null; }
}

export default Object.freeze({ BookmarkTimestampManager, createBookmarkTimestampManager });
