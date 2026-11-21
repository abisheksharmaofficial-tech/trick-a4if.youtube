const STORAGE_KEY_PREFIX = "trick-a4if-tube:video-bookmarks:";
const memoryStorage = new Map();
let bookmarkIdCounter = 0;

function isRecord(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function normalizeText(value, maximumLength = 2000) {
  try {
    return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
  } catch {
    return "";
  }
}

function normalizeTime(value) {
  try {
    const time = Number(value);
    return Number.isFinite(time) && time >= 0 ? time : null;
  } catch {
    return null;
  }
}

function normalizeVideoId(value) {
  try {
    if (typeof value === "string" || typeof value === "number") {
      const id = String(value).trim();
      return id ? id.slice(0, 512) : "";
    }
    if (!isRecord(value)) return "";
    const id = value.videoId ?? value.id ?? value.key ?? value.url ?? value.src;
    return typeof id === "string" || typeof id === "number" ? String(id).trim().slice(0, 512) : "";
  } catch {
    return "";
  }
}

function formatTime(seconds) {
  try {
    const value = normalizeTime(seconds);
    if (value === null) return "";
    const total = Math.floor(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const two = (number) => String(number).padStart(2, "0");
    return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
  } catch {
    return "";
  }
}

function cloneJsonValue(value) {
  try {
    if (!isRecord(value)) return Object.freeze({});
    const json = JSON.stringify(value);
    if (typeof json !== "string") return Object.freeze({});
    const clone = JSON.parse(json);
    return Object.freeze(isRecord(clone) ? clone : {});
  } catch {
    return Object.freeze({});
  }
}

function createId() {
  try {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") return randomUuid.call(globalThis.crypto);
  } catch {
    // Use the local monotonic fallback where crypto is unavailable.
  }
  bookmarkIdCounter += 1;
  return `bookmark-${Date.now().toString(36)}-${bookmarkIdCounter.toString(36)}`;
}

function normalizeBookmark(input, videoId, now = Date.now()) {
  try {
    if (!isRecord(input)) return null;
    const time = normalizeTime(input.timeSeconds ?? input.timestampSeconds ?? input.timestamp ?? input.time);
    if (time === null) return null;
    const createdAtValue = Number(input.createdAt);
    const updatedAtValue = Number(input.updatedAt);
    const createdAt = Number.isFinite(createdAtValue) && createdAtValue >= 0 ? createdAtValue : now;
    const updatedAt = Number.isFinite(updatedAtValue) && updatedAtValue >= 0 ? updatedAtValue : createdAt;
    const metadata = cloneJsonValue(input.videoMetadata ?? input.metadata);
    const id = normalizeText(input.id, 256) || createId();
    const title = normalizeText(input.title, 300);
    const note = normalizeText(input.note, 4000);
    return Object.freeze({
      id,
      videoId: normalizeVideoId(input.videoId) || videoId,
      timeSeconds: time,
      timeString: formatTime(time),
      title,
      note,
      videoMetadata: metadata,
      createdAt,
      updatedAt,
    });
  } catch {
    return null;
  }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function"
      && typeof candidate.setItem === "function" && typeof candidate.removeItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Store timestamped video bookmarks with localStorage persistence and a
 * process-local memory fallback. Timestamps are video positions in seconds;
 * createdAt/updatedAt fields are Unix epoch milliseconds.
 */
export class VideoBookmarker {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.videoId = normalizeVideoId(settings.videoId ?? settings.video ?? settings.videoMetadata);
    this.videoMetadata = cloneJsonValue(settings.videoMetadata ?? settings.metadata);
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512)
      || `${STORAGE_KEY_PREFIX}${encodeURIComponent(this.videoId || "default")}`;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this._bookmarks = [];
    this._load();
  }

  /** Save a bookmark at a video position (seconds). */
  addBookmark(timeSeconds, options = {}) {
    try {
      if (isRecord(timeSeconds)) {
        options = timeSeconds;
        timeSeconds = options.timeSeconds ?? options.timestampSeconds ?? options.timestamp ?? options.time;
      }
      const settings = isRecord(options) ? options : {};
      const time = normalizeTime(timeSeconds);
      if (time === null) return null;
      const now = Date.now();
      const bookmark = normalizeBookmark({
        id: settings.id,
        videoId: settings.videoId,
        timeSeconds: time,
        title: settings.title,
        note: settings.note,
        videoMetadata: settings.videoMetadata ?? settings.metadata ?? this.videoMetadata,
        createdAt: now,
        updatedAt: now,
      }, this.videoId, now);
      if (!bookmark) return null;
      this._bookmarks.push(bookmark);
      this._persist();
      this._notifyChange("added", bookmark);
      return bookmark;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Alias for addBookmark(). */
  add(timeSeconds, options = {}) {
    try {
      return this.addBookmark(timeSeconds, options);
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** List immutable bookmark records, sorted by timestamp (default) or recency. */
  listBookmarks(options = {}) {
    try {
      const settings = typeof options === "string" ? { sortBy: options } : (isRecord(options) ? options : {});
      const sortBy = settings.sortBy ?? settings.sort ?? "timestamp";
      const direction = settings.order === "desc" || settings.descending === true ? -1 : 1;
      const bookmarks = this._bookmarks.slice();
      if (sortBy === "recency" || sortBy === "recent" || sortBy === "createdAt" || sortBy === "updatedAt") {
        bookmarks.sort((left, right) => direction * ((right.updatedAt - left.updatedAt)
          || (right.createdAt - left.createdAt) || left.id.localeCompare(right.id)));
      } else {
        bookmarks.sort((left, right) => direction * ((left.timeSeconds - right.timeSeconds)
          || left.createdAt - right.createdAt || left.id.localeCompare(right.id)));
      }
      const limit = Number(settings.limit);
      const result = Number.isInteger(limit) && limit >= 0 ? bookmarks.slice(0, limit) : bookmarks;
      return Object.freeze(result);
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Find a bookmark by its id. */
  getBookmark(id) {
    try {
      const key = String(id ?? "");
      return this._bookmarks.find((bookmark) => bookmark.id === key) ?? null;
    } catch {
      return null;
    }
  }

  /** Update permitted bookmark fields; timestamp changes are normalized in seconds. */
  updateBookmark(id, changes = {}) {
    try {
      const key = String(id ?? "");
      if (!isRecord(changes)) return null;
      const index = this._bookmarks.findIndex((bookmark) => bookmark.id === key);
      if (index < 0) return null;
      const current = this._bookmarks[index];
      const nextTime = Object.prototype.hasOwnProperty.call(changes, "timeSeconds")
        ? normalizeTime(changes.timeSeconds)
        : (Object.prototype.hasOwnProperty.call(changes, "timestamp")
          ? normalizeTime(changes.timestamp) : current.timeSeconds);
      if (nextTime === null) return null;
      const now = Date.now();
      const updated = normalizeBookmark({
        ...current,
        timeSeconds: nextTime,
        title: Object.prototype.hasOwnProperty.call(changes, "title") ? changes.title : current.title,
        note: Object.prototype.hasOwnProperty.call(changes, "note") ? changes.note : current.note,
        videoMetadata: Object.prototype.hasOwnProperty.call(changes, "videoMetadata")
          ? changes.videoMetadata : (Object.prototype.hasOwnProperty.call(changes, "metadata") ? changes.metadata : current.videoMetadata),
        updatedAt: now,
      }, this.videoId, now);
      if (!updated) return null;
      this._bookmarks[index] = updated;
      this._persist();
      this._notifyChange("updated", updated);
      return updated;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Alias for updateBookmark(). */
  update(id, changes = {}) {
    try {
      return this.updateBookmark(id, changes);
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Remove one bookmark by id. */
  removeBookmark(id) {
    try {
      const key = String(id ?? "");
      const index = this._bookmarks.findIndex((bookmark) => bookmark.id === key);
      if (index < 0) return false;
      const [removed] = this._bookmarks.splice(index, 1);
      this._persist();
      this._notifyChange("removed", removed);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for removeBookmark(). */
  remove(id) {
    try {
      return this.removeBookmark(id);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Clear all bookmarks for this video and storage key. */
  clearBookmarks() {
    try {
      if (!this._bookmarks.length) return true;
      this._bookmarks = [];
      this._persist();
      this._notifyChange("cleared", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for clearBookmarks(). */
  clear() {
    try {
      return this.clearBookmarks();
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Serialize this instance's bookmarks as a versioned JSON string. */
  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = {
        version: 1,
        videoId: this.videoId,
        videoMetadata: this.videoMetadata,
        exportedAt: Date.now(),
        bookmarks: this.listBookmarks({ sortBy: settings.sortBy ?? "timestamp", order: settings.order }),
      };
      return settings.asObject === true ? Object.freeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Import a JSON string or compatible payload; optionally replace existing records. */
  importJSON(input, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { bookmarks: payload };
      if (!isRecord(payload) || !Array.isArray(payload.bookmarks)) return 0;

      const now = Date.now();
      const imported = [];
      const existingIds = new Set(settings.replace === true ? [] : this._bookmarks.map((item) => item.id));
      for (const candidate of payload.bookmarks) {
        const normalized = normalizeBookmark(candidate, this.videoId, now);
        if (!normalized || (normalized.videoId && this.videoId && normalized.videoId !== this.videoId)) continue;
        if (existingIds.has(normalized.id)) {
          if (settings.replace !== true) continue;
          const replacementId = createId();
          imported.push(normalizeBookmark({ ...normalized, id: replacementId }, this.videoId, now));
        } else {
          imported.push(normalized);
          existingIds.add(normalized.id);
        }
      }
      const validImported = imported.filter(Boolean);
      if (settings.replace === true) this._bookmarks = validImported;
      else this._bookmarks.push(...validImported);
      this._persist();
      if (validImported.length || settings.replace === true) this._notifyChange("imported", null);
      return validImported.length;
    } catch (error) {
      this._reportError(error);
      return 0;
    }
  }

  /**
   * Resolve a safe playback seek target. Accepts an id or bookmark record and
   * returns null for missing/invalid targets; durationSeconds optionally clamps
   * the target to the playable duration.
   */
  resolveJumpTarget(bookmarkOrId, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const bookmark = isRecord(bookmarkOrId) ? bookmarkOrId : this.getBookmark(bookmarkOrId);
      if (!bookmark) return null;
      let seconds = normalizeTime(bookmark.timeSeconds ?? bookmark.timestamp ?? bookmark.time);
      if (seconds === null) return null;
      const duration = normalizeTime(settings.durationSeconds ?? settings.duration);
      if (duration !== null) seconds = Math.min(seconds, duration);
      return Object.freeze({
        bookmarkId: normalizeText(bookmark.id, 256),
        videoId: normalizeVideoId(bookmark.videoId) || this.videoId,
        timeSeconds: seconds,
        timeString: formatTime(seconds),
      });
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Resolve a target and safely seek a caller-provided media element. */
  jumpTo(bookmarkOrId, mediaElement, options = {}) {
    try {
      const target = this.resolveJumpTarget(bookmarkOrId, options);
      if (!target || !mediaElement || typeof mediaElement !== "object") return null;
      mediaElement.currentTime = target.timeSeconds;
      return target;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Return current bookmark count. */
  get size() {
    try {
      return this._bookmarks.length;
    } catch {
      return 0;
    }
  }

  _load() {
    try {
      let raw = null;
      if (this.storage) raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const payload = JSON.parse(raw);
      const records = Array.isArray(payload) ? payload : payload?.bookmarks;
      if (!Array.isArray(records)) return;
      const seen = new Set();
      this._bookmarks = records.map((entry) => normalizeBookmark(entry, this.videoId))
        .filter((entry) => {
          if (!entry || (entry.videoId && this.videoId && entry.videoId !== this.videoId) || seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        });
    } catch (error) {
      this._bookmarks = [];
      this._reportError(error);
    }
  }

  _persist() {
    try {
      const value = JSON.stringify({ version: 1, bookmarks: this._bookmarks });
      memoryStorage.set(this.storageKey, value);
      if (this.storage) {
        try {
          this.storage.setItem(this.storageKey, value);
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

  _notifyChange(type, bookmark) {
    try {
      if (this.onChange) this.onChange(Object.freeze({
        type,
        bookmark: bookmark ?? null,
        bookmarks: this.listBookmarks(),
      }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Video bookmark operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt bookmark operations.
    }
  }
}

/** Create a bookmark manager without throwing when storage is unavailable. */
export function createVideoBookmarker(options = {}) {
  try {
    return new VideoBookmarker(options);
  } catch {
    return null;
  }
}

export { formatTime as formatBookmarkTime };

export default Object.freeze({
  VideoBookmarker,
  createVideoBookmarker,
  formatBookmarkTime,
});
