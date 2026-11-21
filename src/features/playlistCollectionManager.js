const STORAGE_KEY = "trick-a4if-tube:playlist-collections:v1";
const memoryStorage = new Map();
const DEFAULT_MAX_PLAYLISTS = 500;
const MAX_PLAYLISTS = 10000;
const DEFAULT_MAX_ITEMS = 10000;
const MAX_TEXT_LENGTH = 10000;

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

function normalizeText(value, maxLength = 2000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.id ?? value.videoId ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeLimit(value, fallback, maximum = MAX_PLAYLISTS) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeVisibility(value, fallback = "private") {
  try {
    const visibility = normalizeText(value, 32).toLowerCase();
    return ["private", "public", "unlisted"].includes(visibility) ? visibility : fallback;
  } catch { return fallback; }
}

function normalizeItem(input) {
  try {
    const source = isRecord(input) ? input : { id: input };
    const id = normalizeId(source.id ?? source.videoId ?? source.key);
    if (!id) return null;
    return Object.freeze({ ...source, id, videoId: id });
  } catch { return null; }
}

function normalizeItems(input, maxItems = DEFAULT_MAX_ITEMS, allowDuplicates = false) {
  try {
    if (!Array.isArray(input) || maxItems <= 0) return [];
    const seen = new Set();
    const items = [];
    for (const candidate of input) {
      const item = normalizeItem(candidate);
      if (!item || (!allowDuplicates && seen.has(item.id))) continue;
      seen.add(item.id);
      items.push(item);
      if (items.length >= maxItems) break;
    }
    return items;
  } catch { return []; }
}

function normalizePlaylist(input, now = Date.now(), defaults = {}) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeId(input.id ?? input.playlistId ?? input.key);
    const name = normalizeText(input.name ?? input.title, 512);
    if (!id || !name) return null;
    const createdAt = normalizeTimestamp(input.createdAt, now);
    return Object.freeze({
      id,
      name,
      description: normalizeText(input.description, MAX_TEXT_LENGTH),
      visibility: normalizeVisibility(input.visibility, defaults.visibility ?? "private"),
      items: Object.freeze(normalizeItems(input.items ?? input.videos, defaults.maxItems ?? DEFAULT_MAX_ITEMS, input.allowDuplicates === true)),
      createdAt,
      updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    });
  } catch { return null; }
}

function safeSerialize(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch { return null; }
}

/**
 * Manage user-provided playlists and their video items with local persistence.
 * IDs are required for playlists and items; no remote fetching or synthetic
 * content is performed. Storage failures leave the manager usable in memory.
 */
export class PlaylistCollectionManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxPlaylists = normalizeLimit(settings.maxPlaylists ?? settings.limit, DEFAULT_MAX_PLAYLISTS, MAX_PLAYLISTS);
      this.maxItemsPerPlaylist = normalizeLimit(settings.maxItemsPerPlaylist ?? settings.maxItems, DEFAULT_MAX_ITEMS, DEFAULT_MAX_ITEMS);
      this.defaultVisibility = normalizeVisibility(settings.visibility, "private");
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._playlists = [];
      this._subscribers = new Set();
      this._load();
      if (Array.isArray(settings.playlists) && this._playlists.length === 0) {
        this.importJSON(settings.playlists, { replace: true, silent: true });
      }
    } catch {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxPlaylists = DEFAULT_MAX_PLAYLISTS;
      this.maxItemsPerPlaylist = DEFAULT_MAX_ITEMS;
      this.defaultVisibility = "private";
      this.onChange = null;
      this.onError = null;
      this.lastError = null;
      this.isDestroyed = false;
      this._playlists = [];
      this._subscribers = new Set();
    }
  }

  createPlaylist(input = {}, options = {}) {
    try {
      if (this.isDestroyed || this._playlists.length >= this.maxPlaylists || !isRecord(input)) return null;
      const settings = isRecord(options) ? options : {};
      const now = Date.now();
      const id = normalizeId(input.id ?? input.playlistId) || this._createId();
      if (this._playlists.some((playlist) => playlist.id === id)) return null;
      const playlist = normalizePlaylist({ ...input, id, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now }, now, {
        visibility: input.visibility ?? this.defaultVisibility,
        maxItems: this.maxItemsPerPlaylist,
      });
      if (!playlist) return null;
      this._playlists.unshift(playlist);
      this._persist();
      if (!settings.silent) this._notify("created", playlist);
      return playlist;
    } catch (error) { this._reportError(error); return null; }
  }

  create(input, options) { return this.createPlaylist(input, options); }

  renamePlaylist(id, name, options = {}) {
    try {
      const playlist = this._find(id);
      const nextName = normalizeText(name, 512);
      if (this.isDestroyed || !playlist || !nextName) return null;
      return this._replace(playlist.id, { name: nextName }, "renamed", options);
    } catch (error) { this._reportError(error); return null; }
  }

  updatePlaylist(id, changes = {}, options = {}) {
    try {
      const playlist = this._find(id);
      if (this.isDestroyed || !playlist || !isRecord(changes)) return null;
      const allowed = {};
      for (const key of ["name", "description", "visibility"]) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) allowed[key] = changes[key];
      }
      if (Object.prototype.hasOwnProperty.call(changes, "name") && !normalizeText(changes.name, 512)) return null;
      if (Object.prototype.hasOwnProperty.call(changes, "items")) {
        allowed.items = normalizeItems(changes.items, this.maxItemsPerPlaylist, changes.allowDuplicates === true);
      }
      return this._replace(playlist.id, allowed, "updated", options);
    } catch (error) { this._reportError(error); return null; }
  }

  updateMetadata(id, metadata = {}, options = {}) { return this.updatePlaylist(id, metadata, options); }

  deletePlaylist(id, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeId(id);
      const index = this._playlists.findIndex((playlist) => playlist.id === normalized);
      if (!normalized || index < 0) return false;
      const [removed] = this._playlists.splice(index, 1);
      this._persist();
      if (options?.silent !== true) this._notify("deleted", removed);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  delete(id, options) { return this.deletePlaylist(id, options); }

  duplicatePlaylist(id, options = {}) {
    try {
      const source = this._find(id);
      if (this.isDestroyed || !source || this._playlists.length >= this.maxPlaylists) return null;
      const settings = isRecord(options) ? options : {};
      const now = Date.now();
      const duplicateId = normalizeId(settings.id) || this._createId();
      if (this._playlists.some((playlist) => playlist.id === duplicateId)) return null;
      const copy = normalizePlaylist({
        ...source,
        id: duplicateId,
        name: normalizeText(settings.name, 512) || `${source.name} (copy)`,
        createdAt: now,
        updatedAt: now,
      }, now, { maxItems: this.maxItemsPerPlaylist });
      if (!copy) return null;
      this._playlists.unshift(copy);
      this._persist();
      if (settings.silent !== true) this._notify("duplicated", copy);
      return copy;
    } catch (error) { this._reportError(error); return null; }
  }

  addItem(playlistId, item, options = {}) {
    try {
      const playlist = this._find(playlistId);
      const normalized = normalizeItem(item);
      if (this.isDestroyed || !playlist || !normalized) return false;
      const settings = isRecord(options) ? options : {};
      const items = playlist.items.slice();
      const existing = items.findIndex((candidate) => candidate.id === normalized.id);
      if (existing >= 0 && settings.allowDuplicate !== true && settings.allowDuplicates !== true) return false;
      const index = this._index(settings.index, items.length, items.length);
      items.splice(index, 0, normalized);
      const capped = items.slice(0, this.maxItemsPerPlaylist);
      if (capped.length === items.length - 1) return false;
      this._replace(playlist.id, { items: capped }, "item-added", settings);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  addVideo(playlistId, item, options) { return this.addItem(playlistId, item, options); }

  removeItem(playlistId, itemId, options = {}) {
    try {
      const playlist = this._find(playlistId);
      if (this.isDestroyed || !playlist) return false;
      const normalized = normalizeId(itemId);
      const index = playlist.items.findIndex((item) => item.id === normalized);
      if (!normalized || index < 0) return false;
      const items = playlist.items.slice();
      const [removed] = items.splice(index, 1);
      this._replace(playlist.id, { items }, "item-removed", options, removed);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeVideo(playlistId, itemId, options) { return this.removeItem(playlistId, itemId, options); }

  moveItem(playlistId, from, to, options = {}) {
    try {
      const playlist = this._find(playlistId);
      if (this.isDestroyed || !playlist) return false;
      const fromIndex = typeof from === "number" ? this._index(from, playlist.items.length, -1) : playlist.items.findIndex((item) => item.id === normalizeId(from));
      const toIndex = this._index(to, playlist.items.length, -1);
      if (fromIndex < 0 || fromIndex >= playlist.items.length || toIndex < 0 || toIndex >= playlist.items.length || fromIndex === toIndex) return false;
      const items = playlist.items.slice();
      const [item] = items.splice(fromIndex, 1);
      items.splice(toIndex, 0, item);
      this._replace(playlist.id, { items }, "item-moved", options, item);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  reorderItems(playlistId, order, options = {}) {
    try {
      const playlist = this._find(playlistId);
      if (this.isDestroyed || !playlist || !Array.isArray(order)) return false;
      const itemsById = new Map(playlist.items.map((item) => [item.id, item]));
      const reordered = [];
      const used = new Set();
      for (const value of order) {
        const id = normalizeId(value);
        const item = itemsById.get(id);
        if (!item || used.has(id)) return false;
        used.add(id);
        reordered.push(item);
      }
      if (reordered.length !== playlist.items.length) return false;
      this._replace(playlist.id, { items: reordered }, "items-reordered", options);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getPlaylist(id) { try { return this._find(id); } catch { return null; } }
  get(id) { return this.getPlaylist(id); }

  getPlaylists(options = {}) {
    try {
      const settings = typeof options === "string" ? { search: options } : (isRecord(options) ? options : {});
      let playlists = this._playlists.slice();
      const query = normalizeText(settings.search ?? settings.query, 1000).toLocaleLowerCase();
      if (query) playlists = playlists.filter((playlist) => [playlist.name, playlist.description, playlist.visibility]
        .some((value) => value.toLocaleLowerCase().includes(query))
        || playlist.items.some((item) => this._itemMatches(item, query)));
      if (settings.visibility) playlists = playlists.filter((playlist) => playlist.visibility === normalizeVisibility(settings.visibility, ""));
      if (settings.hasItems === true) playlists = playlists.filter((playlist) => playlist.items.length > 0);
      if (settings.hasItems === false) playlists = playlists.filter((playlist) => playlist.items.length === 0);
      if (settings.sortBy === "name") playlists.sort((a, b) => a.name.localeCompare(b.name));
      else if (settings.sortBy === "createdAt") playlists.sort((a, b) => a.createdAt - b.createdAt);
      else if (settings.sortBy === "updatedAt") playlists.sort((a, b) => a.updatedAt - b.updatedAt);
      if (settings.order === "desc") playlists.reverse();
      const offset = normalizeLimit(settings.offset ?? 0, 0, MAX_PLAYLISTS);
      const limit = settings.limit === undefined ? playlists.length : normalizeLimit(settings.limit, 0, MAX_PLAYLISTS);
      return Object.freeze(playlists.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  list(options = {}) { return this.getPlaylists(options); }

  searchPlaylists(query, options = {}) { return this.getPlaylists({ ...((isRecord(options)) ? options : {}), search: query }); }

  searchItems(playlistId, query, options = {}) {
    try {
      const playlist = this._find(playlistId);
      if (!playlist) return Object.freeze([]);
      const normalized = normalizeText(query, 1000).toLocaleLowerCase();
      let items = playlist.items.filter((item) => !normalized || this._itemMatches(item, normalized));
      if (options?.sortBy === "title") items.sort((a, b) => normalizeText(a.title).localeCompare(normalizeText(b.title)));
      const offset = normalizeLimit(options?.offset ?? 0, 0, DEFAULT_MAX_ITEMS);
      const limit = options?.limit === undefined ? items.length : normalizeLimit(options.limit, 0, DEFAULT_MAX_ITEMS);
      return Object.freeze(items.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 1, exportedAt: Date.now(), playlists: this._playlists };
      return settings.asObject === true ? Object.freeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { playlists: payload };
      if (!isRecord(payload)) return 0;
      const candidates = payload.playlists ?? payload.collections ?? payload.items;
      if (!Array.isArray(candidates)) return 0;
      const byId = new Map(settings.replace === true ? [] : this._playlists.map((playlist) => [playlist.id, playlist]));
      let imported = 0;
      const now = Date.now();
      for (const candidate of candidates) {
        const playlist = normalizePlaylist(candidate, now, { maxItems: this.maxItemsPerPlaylist, visibility: this.defaultVisibility });
        if (!playlist) continue;
        byId.set(playlist.id, playlist);
        imported += 1;
      }
      this._playlists = [...byId.values()].slice(0, this.maxPlaylists);
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

  get size() { try { return this._playlists.length; } catch { return 0; } }

  destroy() {
    try { this.isDestroyed = true; this._subscribers.clear(); return true; }
    catch { return false; }
  }

  _find(id) {
    const normalized = normalizeId(id);
    return normalized ? this._playlists.find((playlist) => playlist.id === normalized) ?? null : null;
  }

  _replace(id, changes, type, options = {}, entry = null) {
    try {
      const index = this._playlists.findIndex((playlist) => playlist.id === id);
      if (index < 0) return null;
      const existing = this._playlists[index];
      const merged = normalizePlaylist({ ...existing, ...changes, id, createdAt: existing.createdAt, updatedAt: Date.now() }, Date.now(), {
        visibility: this.defaultVisibility,
        maxItems: this.maxItemsPerPlaylist,
      });
      if (!merged) return null;
      this._playlists[index] = merged;
      this._persist();
      if (options?.silent !== true) this._notify(type, merged, entry);
      return merged;
    } catch (error) { this._reportError(error); return null; }
  }

  _index(value, length, fallback) {
    try { const index = Number(value); return Number.isInteger(index) && index >= 0 && index < length ? index : fallback; }
    catch { return fallback; }
  }

  _itemMatches(item, query) {
    try {
      return [item.id, item.videoId, item.title, item.name, item.channel, item.channelName, item.description, item.category, item.tags]
        .some((value) => (Array.isArray(value) ? value : [value]).some((part) => normalizeText(part, 10000).toLocaleLowerCase().includes(query)));
    } catch { return false; }
  }

  _createId() {
    try {
      const randomUUID = globalThis.crypto?.randomUUID;
      if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
    } catch { /* Use a local counter fallback when crypto is unavailable. */ }
    this._idCounter = (this._idCounter ?? 0) + 1;
    return `playlist-${Date.now().toString(36)}-${this._idCounter.toString(36)}`;
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
      const candidates = Array.isArray(payload) ? payload : payload?.playlists;
      if (!Array.isArray(candidates)) return;
      const byId = new Map();
      for (const candidate of candidates) {
        const playlist = normalizePlaylist(candidate, Date.now(), { maxItems: this.maxItemsPerPlaylist, visibility: this.defaultVisibility });
        if (playlist) byId.set(playlist.id, playlist);
      }
      this._playlists = [...byId.values()].slice(0, this.maxPlaylists);
    } catch (error) { this._playlists = []; this._reportError(error); }
  }

  _persist() {
    try {
      const serialized = safeSerialize({ version: 1, playlists: this._playlists });
      if (serialized === null) return false;
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, playlist, entry = null) {
    try {
      const event = Object.freeze({ type, playlist: playlist ?? null, entry, playlists: Object.freeze(this._playlists.slice()) });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Playlist collection operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate error handlers. */ }
    } catch { /* Error handling must never interrupt playlist operations. */ }
  }
}

/** Create a playlist manager without throwing if setup or browser storage fails. */
export function createPlaylistCollectionManager(options = {}) {
  try { return new PlaylistCollectionManager(options); }
  catch { return null; }
}

export default Object.freeze({ PlaylistCollectionManager, createPlaylistCollectionManager });
