const STORAGE_KEY = "trick-a4if-tube:queue-playlists:v1";
const memoryStorage = new Map();
const REPEAT_MODES = Object.freeze(["none", "one", "all"]);
const MAX_ITEMS = 10000;
const MAX_PLAYLISTS = 1000;

function isRecord(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function normalizeText(value, maxLength = 1000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch {
    return "";
  }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.videoId ?? value.id ?? value.key ?? value.url, 512);
    return normalizeText(value, 512);
  } catch {
    return "";
  }
}

function normalizeItem(input) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeId(input);
    if (!id) return null;
    const item = { ...input, id, videoId: id };
    return Object.freeze(item);
  } catch {
    return null;
  }
}

function normalizeRepeatMode(mode, fallback = "none") {
  try {
    const value = normalizeText(mode, 20).toLocaleLowerCase();
    return REPEAT_MODES.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function normalizeCollection(items) {
  try {
    if (!Array.isArray(items)) return [];
    const unique = new Set();
    const result = [];
    for (const candidate of items) {
      const item = normalizeItem(candidate);
      if (!item || unique.has(item.id)) continue;
      unique.add(item.id);
      result.push(item);
      if (result.length >= MAX_ITEMS) break;
    }
    return result;
  } catch {
    return [];
  }
}

function normalizeIndex(value, length, fallback = -1) {
  try {
    const index = Number(value);
    if (!Number.isInteger(index)) return fallback;
    return index >= 0 && index < length ? index : fallback;
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
 * Manage a playback queue and named playlists. Items are deduplicated by their
 * video id within each collection. State is persisted to localStorage when
 * available and otherwise kept in a process-local memory fallback.
 */
export class QueuePlaylistManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.queue = normalizeCollection(settings.queue);
    this.activeIndex = normalizeIndex(settings.activeIndex, this.queue.length, this.queue.length ? 0 : -1);
    this.shuffle = Boolean(settings.shuffle);
    this.repeatMode = normalizeRepeatMode(settings.repeatMode);
    this.playlists = new Map();
    this._shuffleHistory = [];
    this._shufflePosition = -1;
    this._load();
  }

  /** Add a queue item. Duplicate ids are ignored unless moveExisting is requested. */
  addToQueue(item, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const normalized = normalizeItem(item);
      if (!normalized) return false;
      const index = this.queue.findIndex((entry) => entry.id === normalized.id);
      if (index >= 0) {
        if (settings.moveExisting === true) {
          const [existing] = this.queue.splice(index, 1);
          const insertion = this._resolveInsertionIndex(settings.index, this.queue.length);
          this.queue.splice(insertion, 0, Object.freeze({ ...existing, ...normalized }));
          this._adjustActiveAfterMove(index, insertion);
          this._persist();
          this._notifyChange("queue-item-moved", normalized);
        }
        return false;
      }
      const insertion = this._resolveInsertionIndex(settings.index, this.queue.length);
      this.queue.splice(insertion, 0, normalized);
      if (this.activeIndex < 0) this.activeIndex = insertion;
      else if (insertion <= this.activeIndex) this.activeIndex += 1;
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("queue-item-added", normalized);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for addToQueue(). */
  enqueue(item, options = {}) {
    try { return this.addToQueue(item, options); } catch (error) { this._reportError(error); return false; }
  }

  /** Add multiple items, ignoring malformed and duplicate entries. */
  addManyToQueue(items, options = {}) {
    try {
      if (!Array.isArray(items)) return 0;
      let added = 0;
      for (const item of items) if (this.addToQueue(item, options)) added += 1;
      return added;
    } catch (error) {
      this._reportError(error);
      return 0;
    }
  }

  /** Remove a queue item by id or queue index. */
  removeFromQueue(idOrIndex) {
    try {
      const index = typeof idOrIndex === "number"
        ? normalizeIndex(idOrIndex, this.queue.length)
        : this.queue.findIndex((item) => item.id === normalizeId(idOrIndex));
      if (index < 0) return false;
      const [removed] = this.queue.splice(index, 1);
      if (this.queue.length === 0) this.activeIndex = -1;
      else if (index < this.activeIndex) this.activeIndex -= 1;
      else if (index === this.activeIndex) this.activeIndex = Math.min(index, this.queue.length - 1);
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("queue-item-removed", removed);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Reorder an item from one queue index to another. */
  moveQueueItem(fromIndex, toIndex) {
    try {
      const from = normalizeIndex(fromIndex, this.queue.length);
      const target = Number(toIndex);
      if (from < 0 || !Number.isInteger(target) || target < 0 || target >= this.queue.length) return false;
      if (from === target) return true;
      const [item] = this.queue.splice(from, 1);
      this.queue.splice(target, 0, item);
      this._adjustActiveAfterMove(from, target);
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("queue-reordered", item);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set the current queue item by index or item id. */
  setActiveIndex(indexOrId) {
    try {
      const index = typeof indexOrId === "number"
        ? normalizeIndex(indexOrId, this.queue.length)
        : this.queue.findIndex((item) => item.id === normalizeId(indexOrId));
      if (index < 0) return false;
      this.activeIndex = index;
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("active-changed", this.queue[index]);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Current queue item, or null when the queue is empty. */
  getCurrent() {
    try { return this.activeIndex >= 0 ? this.queue[this.activeIndex] ?? null : null; } catch { return null; }
  }

  /** Advance to the next item respecting repeat and shuffle settings. */
  next() {
    try {
      if (!this.queue.length) return null;
      if (this.repeatMode === "one" && this.activeIndex >= 0) return this.getCurrent();
      let index;
      if (this.shuffle) index = this._nextShuffleIndex();
      else if (this.activeIndex < 0) index = 0;
      else if (this.activeIndex + 1 < this.queue.length) index = this.activeIndex + 1;
      else if (this.repeatMode === "all") index = 0;
      else return null;
      this.activeIndex = index;
      this._persist();
      this._notifyChange("active-changed", this.queue[index]);
      return this.queue[index] ?? null;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Move to the previous item, wrapping only when repeat-all is enabled. */
  previous() {
    try {
      if (!this.queue.length) return null;
      if (this.repeatMode === "one" && this.activeIndex >= 0) return this.getCurrent();
      let index;
      if (this.shuffle) index = this._previousShuffleIndex();
      else if (this.activeIndex < 0) index = 0;
      else if (this.activeIndex > 0) index = this.activeIndex - 1;
      else if (this.repeatMode === "all") index = this.queue.length - 1;
      else return null;
      this.activeIndex = index;
      this._persist();
      this._notifyChange("active-changed", this.queue[index]);
      return this.queue[index] ?? null;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Configure shuffle behavior. */
  setShuffle(enabled) {
    try {
      this.shuffle = Boolean(enabled);
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("shuffle-changed", null);
      return this.shuffle;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set repeat mode to none, one, or all. */
  setRepeatMode(mode) {
    try {
      const normalized = normalizeRepeatMode(mode, "");
      if (!normalized) return false;
      this.repeatMode = normalized;
      this._persist();
      this._notifyChange("repeat-changed", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Clear queue items. */
  clearQueue() {
    try {
      if (!this.queue.length) return true;
      this.queue = [];
      this.activeIndex = -1;
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("queue-cleared", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Create an empty named playlist. */
  createPlaylist(name, options = {}) {
    try {
      const title = normalizeText(name, 200);
      if (!title) return false;
      const settings = isRecord(options) ? options : {};
      const id = normalizeText(settings.id, 256) || title;
      if (this.playlists.has(id) || this.playlists.size >= MAX_PLAYLISTS) return false;
      const playlist = { id, name: title, items: normalizeCollection(settings.items), createdAt: Date.now(), updatedAt: Date.now() };
      this.playlists.set(id, playlist);
      this._persist();
      this._notifyChange("playlist-created", Object.freeze({ ...playlist, items: Object.freeze(playlist.items.slice()) }));
      return id;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Rename a playlist. */
  renamePlaylist(id, name) {
    try {
      const playlist = this.playlists.get(normalizeText(id, 256));
      const title = normalizeText(name, 200);
      if (!playlist || !title) return false;
      playlist.name = title;
      playlist.updatedAt = Date.now();
      this._persist();
      this._notifyChange("playlist-renamed", this.getPlaylist(playlist.id));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Delete a named playlist. */
  deletePlaylist(id) {
    try {
      const key = normalizeText(id, 256);
      if (!this.playlists.has(key)) return false;
      const deleted = this.playlists.delete(key);
      if (deleted) {
        this._persist();
        this._notifyChange("playlist-deleted", Object.freeze({ id: key }));
      }
      return deleted;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Get an immutable playlist snapshot. */
  getPlaylist(id) {
    try {
      const playlist = this.playlists.get(normalizeText(id, 256));
      return playlist ? Object.freeze({
        id: playlist.id,
        name: playlist.name,
        items: Object.freeze(playlist.items.slice()),
        createdAt: playlist.createdAt,
        updatedAt: playlist.updatedAt,
      }) : null;
    } catch { return null; }
  }

  /** List all named playlists. */
  listPlaylists() {
    try { return Object.freeze([...this.playlists.keys()].map((id) => this.getPlaylist(id)).filter(Boolean)); } catch { return Object.freeze([]); }
  }

  /** Add an item to a playlist; duplicate ids are ignored. */
  addToPlaylist(playlistId, item, options = {}) {
    try {
      const playlist = this.playlists.get(normalizeText(playlistId, 256));
      const normalized = normalizeItem(item);
      if (!playlist || !normalized) return false;
      const existing = playlist.items.findIndex((entry) => entry.id === normalized.id);
      if (existing >= 0) {
        if (isRecord(options) && options.moveExisting === true) {
          const [current] = playlist.items.splice(existing, 1);
          playlist.items.splice(this._resolveInsertionIndex(options.index, playlist.items.length), 0, Object.freeze({ ...current, ...normalized }));
          playlist.updatedAt = Date.now();
          this._persist();
          this._notifyChange("playlist-item-moved", this.getPlaylist(playlist.id));
        }
        return false;
      }
      const insertion = this._resolveInsertionIndex(isRecord(options) ? options.index : undefined, playlist.items.length);
      playlist.items.splice(insertion, 0, normalized);
      playlist.updatedAt = Date.now();
      this._persist();
      this._notifyChange("playlist-item-added", this.getPlaylist(playlist.id));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Remove a playlist item by id or index. */
  removeFromPlaylist(playlistId, idOrIndex) {
    try {
      const playlist = this.playlists.get(normalizeText(playlistId, 256));
      if (!playlist) return false;
      const index = typeof idOrIndex === "number"
        ? normalizeIndex(idOrIndex, playlist.items.length)
        : playlist.items.findIndex((item) => item.id === normalizeId(idOrIndex));
      if (index < 0) return false;
      playlist.items.splice(index, 1);
      playlist.updatedAt = Date.now();
      this._persist();
      this._notifyChange("playlist-item-removed", this.getPlaylist(playlist.id));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Move an item within a named playlist. */
  movePlaylistItem(playlistId, fromIndex, toIndex) {
    try {
      const playlist = this.playlists.get(normalizeText(playlistId, 256));
      if (!playlist) return false;
      const from = normalizeIndex(fromIndex, playlist.items.length);
      const target = Number(toIndex);
      if (from < 0 || !Number.isInteger(target) || target < 0 || target >= playlist.items.length) return false;
      if (from === target) return true;
      const [item] = playlist.items.splice(from, 1);
      playlist.items.splice(target, 0, item);
      playlist.updatedAt = Date.now();
      this._persist();
      this._notifyChange("playlist-reordered", this.getPlaylist(playlist.id));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Clear one playlist, or all queue and playlist content when no id is given. */
  clear(id = undefined) {
    try {
      if (id !== undefined) {
        const playlist = this.playlists.get(normalizeText(id, 256));
        if (!playlist) return false;
        playlist.items = [];
        playlist.updatedAt = Date.now();
        this._persist();
        this._notifyChange("playlist-cleared", this.getPlaylist(playlist.id));
        return true;
      }
      this.queue = [];
      this.activeIndex = -1;
      this.playlists.clear();
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("state-cleared", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Export queue and playlists as versioned JSON or a plain object. */
  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = {
        version: 1,
        queue: this.queue.slice(),
        activeIndex: this.activeIndex,
        shuffle: this.shuffle,
        repeatMode: this.repeatMode,
        playlists: this.listPlaylists(),
      };
      return settings.asObject === true
        ? Object.freeze(payload)
        : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Import serialized state. By default, imported queue items merge by id. */
  importJSON(input, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (!isRecord(payload)) return false;
      const importedQueue = normalizeCollection(payload.queue);
      const replace = settings.replace === true;
      if (replace) {
        this.queue = importedQueue;
      } else {
        const byId = new Map(this.queue.map((item) => [item.id, item]));
        for (const item of importedQueue) if (!byId.has(item.id)) byId.set(item.id, item);
        this.queue = [...byId.values()].slice(0, MAX_ITEMS);
      }
      const requestedIndex = normalizeIndex(payload.activeIndex, this.queue.length, this.queue.length ? 0 : -1);
      this.activeIndex = requestedIndex;
      if (typeof payload.shuffle === "boolean") this.shuffle = payload.shuffle;
      if (payload.repeatMode !== undefined) this.repeatMode = normalizeRepeatMode(payload.repeatMode, this.repeatMode);

      if (Array.isArray(payload.playlists)) {
        for (const candidate of payload.playlists.slice(0, MAX_PLAYLISTS)) {
          if (!isRecord(candidate)) continue;
          const id = normalizeText(candidate.id ?? candidate.name, 256);
          const name = normalizeText(candidate.name ?? candidate.id, 200);
          if (!id || !name) continue;
          const existing = this.playlists.get(id);
          const items = normalizeCollection(candidate.items);
          if (replace || !existing) {
            this.playlists.set(id, {
              id,
              name,
              items,
              createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : Date.now(),
              updatedAt: Date.now(),
            });
          } else {
            const itemMap = new Map(existing.items.map((item) => [item.id, item]));
            for (const item of items) if (!itemMap.has(item.id)) itemMap.set(item.id, item);
            existing.items = [...itemMap.values()].slice(0, MAX_ITEMS);
            existing.updatedAt = Date.now();
          }
        }
      }
      this._resetShuffleHistory();
      this._persist();
      this._notifyChange("state-imported", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Immutable snapshot of queue, current item, shuffle and repeat state. */
  getState() {
    try {
      return Object.freeze({
        queue: Object.freeze(this.queue.slice()),
        activeIndex: this.activeIndex,
        current: this.getCurrent(),
        shuffle: this.shuffle,
        repeatMode: this.repeatMode,
        playlists: this.listPlaylists(),
      });
    } catch { return null; }
  }

  _resolveInsertionIndex(index, length) {
    try {
      const value = Number(index);
      return Number.isInteger(value) ? Math.min(length, Math.max(0, value)) : length;
    } catch { return length; }
  }

  _adjustActiveAfterMove(from, to) {
    try {
      if (this.activeIndex === from) this.activeIndex = to;
      else if (from < this.activeIndex && to >= this.activeIndex) this.activeIndex -= 1;
      else if (from > this.activeIndex && to <= this.activeIndex) this.activeIndex += 1;
    } catch (error) { this._reportError(error); }
  }

  _resetShuffleHistory() {
    try {
      this._shuffleHistory = this.activeIndex >= 0 ? [this.activeIndex] : [];
      this._shufflePosition = this._shuffleHistory.length - 1;
    } catch {
      this._shuffleHistory = [];
      this._shufflePosition = -1;
    }
  }

  _nextShuffleIndex() {
    try {
      if (this._shufflePosition + 1 < this._shuffleHistory.length) {
        this._shufflePosition += 1;
        return this._shuffleHistory[this._shufflePosition];
      }
      const choices = this.queue.map((_, index) => index).filter((index) => index !== this.activeIndex);
      if (!choices.length) return this.repeatMode === "all" ? Math.max(this.activeIndex, 0) : Math.max(this.activeIndex, 0);
      if (this.activeIndex < 0 && this._shuffleHistory.length === 0) choices.push(0);
      let selected = choices[Math.floor(Math.random() * choices.length)];
      if (selected === undefined) selected = 0;
      this._shuffleHistory.push(selected);
      if (this._shuffleHistory.length > this.queue.length * 2) this._shuffleHistory.shift();
      this._shufflePosition = this._shuffleHistory.length - 1;
      return selected;
    } catch {
      return this.queue.length ? 0 : -1;
    }
  }

  _previousShuffleIndex() {
    try {
      if (this._shufflePosition > 0) {
        this._shufflePosition -= 1;
        return this._shuffleHistory[this._shufflePosition];
      }
      if (this.repeatMode === "all" && this.queue.length) return (this.activeIndex - 1 + this.queue.length) % this.queue.length;
      return this.activeIndex;
    } catch { return this.activeIndex; }
  }

  _load() {
    try {
      let raw = null;
      if (this.storage) raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (!isRecord(payload)) return;
      this.queue = normalizeCollection(payload.queue);
      this.activeIndex = normalizeIndex(payload.activeIndex, this.queue.length, this.queue.length ? 0 : -1);
      this.shuffle = Boolean(payload.shuffle);
      this.repeatMode = normalizeRepeatMode(payload.repeatMode);
      this.playlists.clear();
      if (Array.isArray(payload.playlists)) {
        for (const candidate of payload.playlists.slice(0, MAX_PLAYLISTS)) {
          if (!isRecord(candidate)) continue;
          const id = normalizeText(candidate.id ?? candidate.name, 256);
          const name = normalizeText(candidate.name ?? candidate.id, 200);
          if (!id || !name) continue;
          this.playlists.set(id, {
            id,
            name,
            items: normalizeCollection(candidate.items),
            createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : Date.now(),
            updatedAt: Number.isFinite(Number(candidate.updatedAt)) ? Number(candidate.updatedAt) : Date.now(),
          });
        }
      }
      this._resetShuffleHistory();
    } catch (error) {
      this._reportError(error);
    }
  }

  _persist() {
    try {
      const value = JSON.stringify({
        version: 1,
        queue: this.queue,
        activeIndex: this.activeIndex,
        shuffle: this.shuffle,
        repeatMode: this.repeatMode,
        playlists: this.listPlaylists(),
      });
      memoryStorage.set(this.storageKey, value);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, value); } catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _notifyChange(type, value) {
    try {
      if (this.onChange) this.onChange(Object.freeze({ type, value: value ?? null, state: this.getState() }));
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Queue and playlist operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt queue operations.
    }
  }
}

/** Create a queue and playlist manager with safe storage fallback. */
export function createQueuePlaylistManager(options = {}) {
  try {
    return new QueuePlaylistManager(options);
  } catch {
    return null;
  }
}

export const QUEUE_REPEAT_MODES = REPEAT_MODES;

export default Object.freeze({
  QUEUE_REPEAT_MODES,
  QueuePlaylistManager,
  createQueuePlaylistManager,
});
