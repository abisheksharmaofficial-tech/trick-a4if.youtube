const STORAGE_KEY = "trick-a4if-tube:watch-later";
const DEFAULT_MAX_ITEMS = 500;
const MAX_TEXT_LENGTH = 4096;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  try { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
  catch { return ""; }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.id ?? value.videoId ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeNonNegativeNumber(value, fallback = 0) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeItem(input, now = Date.now()) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeId(input.id ?? input.videoId ?? input.key);
    if (!id) return null;
    const addedAtValue = Number(input.addedAt ?? input.addedAtTimestamp);
    return Object.freeze({
      id,
      title: normalizeText(input.title),
      category: normalizeText(input.category, 512),
      thumbnail: normalizeText(input.thumbnail ?? input.thumbnailUrl, 8192),
      channel: normalizeText(input.channel ?? input.channelName ?? input.author ?? input.uploader, 1024),
      author: normalizeText(input.author ?? input.channel ?? input.channelName ?? input.uploader, 1024),
      duration: normalizeNonNegativeNumber(input.duration ?? input.durationSeconds, 0),
      note: normalizeText(input.note, 8192),
      addedAt: Number.isFinite(addedAtValue) && addedAtValue >= 0 ? addedAtValue : now,
      watched: input.watched === true,
    });
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeLimit(value) {
  try {
    if (value === Infinity) return Infinity;
    const limit = Number(value);
    return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_MAX_ITEMS;
  } catch { return DEFAULT_MAX_ITEMS; }
}

function normalizeSort(value) {
  try {
    const sort = normalizeText(value, 32).toLowerCase();
    return ["added-asc", "added-desc", "title-asc", "title-desc", "duration-asc", "duration-desc"].includes(sort)
      ? sort : "added-desc";
  } catch { return "added-desc"; }
}

/**
 * Persist and query a user's Watch Later collection. Storage errors are
 * contained; current state remains usable in memory for the manager lifetime.
 */
export class WatchLaterManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.maxItems = normalizeLimit(settings.maxItems ?? settings.capacity ?? DEFAULT_MAX_ITEMS);
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._items = new Map();
    this._subscribers = new Set();
    this._load();
    if (Array.isArray(settings.items) && this._items.size === 0) this.importItems(settings.items, { replace: true, silent: true });
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Watch Later operation failed.");
      if (this.onError) this.onError(this.lastError, this);
    } catch { /* Error handling must not interrupt persistence or subscribers. */ }
  }

  _load() {
    try {
      let serialized = null;
      try { serialized = this.storage?.getItem(this.storageKey); }
      catch (error) { this._reportError(error); }
      if (typeof serialized !== "string" || !serialized) return false;
      const parsed = JSON.parse(serialized);
      const data = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : null);
      if (!data) return false;
      this._items = this._normalizeCollection(data);
      return true;
    } catch (error) {
      this._reportError(error);
      this._items = new Map();
      return false;
    }
  }

  _normalizeCollection(items) {
    try {
      const normalized = new Map();
      if (!Array.isArray(items)) return normalized;
      for (const candidate of items) {
        const item = normalizeItem(candidate);
        if (!item) continue;
        if (normalized.has(item.id)) normalized.delete(item.id);
        normalized.set(item.id, item);
      }
      while (normalized.size > this.maxItems) normalized.delete(normalized.keys().next().value);
      return normalized;
    } catch (error) { this._reportError(error); return new Map(); }
  }

  _persist() {
    try {
      if (!this.storage || typeof this.storage.setItem !== "function") return false;
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, items: this.getItems() }));
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _notify(type, item = null, details = {}) {
    try {
      const event = Object.freeze({
        type,
        item,
        items: this.getItems(),
        count: this._items.size,
        ...details,
      });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const subscriber of [...this._subscribers]) {
        try { subscriber(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _commit(type, item = null, details = {}) {
    try {
      this._persist();
      this._notify(type, item, details);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Add an item; duplicate IDs return the existing item unless updateExisting is set. */
  addItem(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxItems === 0) return null;
      const item = normalizeItem(input);
      if (!item) return null;
      const settings = isRecord(options) ? options : {};
      const existing = this._items.get(item.id);
      if (existing && settings.updateExisting !== true) return existing;
      if (!existing && this._items.size >= this.maxItems) {
        if (settings.evictOldest !== true) return null;
        this._items.delete(this._items.keys().next().value);
      }
      const stored = existing
        ? normalizeItem({ ...existing, ...input, id: existing.id, addedAt: existing.addedAt })
        : item;
      if (!stored) return null;
      this._items.delete(stored.id);
      this._items.set(stored.id, stored);
      this._commit(existing ? "update" : "add", stored, { evicted: this._items.size > this.maxItems });
      return stored;
    } catch (error) { this._reportError(error); return null; }
  }

  add(input, options) { return this.addItem(input, options); }

  removeItem(id) {
    try {
      if (this.isDestroyed) return false;
      const itemId = normalizeId(id);
      if (!itemId || !this._items.has(itemId)) return false;
      const item = this._items.get(itemId);
      this._items.delete(itemId);
      this._commit("remove", item);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  remove(id) { return this.removeItem(id); }

  toggleItem(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const id = normalizeId(input);
      if (id && this._items.has(id)) return this.removeItem(id) ? false : this._items.get(id) ?? false;
      const added = this.addItem(input, options);
      return added ?? false;
    } catch (error) { this._reportError(error); return false; }
  }

  toggle(input, options) { return this.toggleItem(input, options); }

  setWatched(id, watched = true) {
    try {
      if (this.isDestroyed) return false;
      const itemId = normalizeId(id);
      const existing = this._items.get(itemId);
      if (!existing) return false;
      const updated = Object.freeze({ ...existing, watched: Boolean(watched) });
      this._items.set(itemId, updated);
      this._commit("watched", updated);
      return updated;
    } catch (error) { this._reportError(error); return false; }
  }

  markWatched(id) { return this.setWatched(id, true); }
  markUnwatched(id) { return this.setWatched(id, false); }

  getItem(id) {
    try { return this._items.get(normalizeId(id)) ?? null; }
    catch (error) { this._reportError(error); return null; }
  }

  has(id) {
    try { return this._items.has(normalizeId(id)); }
    catch { return false; }
  }

  getItems(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let items = Array.from(this._items.values());
      if (settings.watched !== undefined) items = items.filter((item) => item.watched === Boolean(settings.watched));
      if (settings.unwatched === true) items = items.filter((item) => !item.watched);
      const category = normalizeText(settings.category, 512).toLocaleLowerCase();
      if (category) items = items.filter((item) => item.category.toLocaleLowerCase() === category);
      const query = normalizeText(settings.query ?? settings.search, 1024).toLocaleLowerCase();
      if (query) {
        items = items.filter((item) => [item.id, item.title, item.category, item.channel, item.author, item.note]
          .some((value) => value.toLocaleLowerCase().includes(query)));
      }
      const sort = normalizeSort(settings.sort);
      items.sort((left, right) => {
        switch (sort) {
          case "added-asc": return left.addedAt - right.addedAt || left.id.localeCompare(right.id);
          case "title-asc": return left.title.localeCompare(right.title) || left.addedAt - right.addedAt;
          case "title-desc": return right.title.localeCompare(left.title) || right.addedAt - left.addedAt;
          case "duration-asc": return left.duration - right.duration || left.addedAt - right.addedAt;
          case "duration-desc": return right.duration - left.duration || right.addedAt - left.addedAt;
          default: return right.addedAt - left.addedAt || right.id.localeCompare(left.id);
        }
      });
      if (settings.limit != null) {
        const limit = Number(settings.limit);
        if (Number.isFinite(limit) && limit >= 0) items = items.slice(0, Math.floor(limit));
      }
      return Object.freeze(items);
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  query(options = {}) { return this.getItems(options); }
  get count() { return this._items.size; }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (this._items.size === 0) return true;
      const previousCount = this._items.size;
      this._items.clear();
      this._commit("clear", null, { previousCount });
      if (isRecord(options) && options.removeStorage === true) {
        try { this.storage?.removeItem?.(this.storageKey); } catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  exportJSON(space = 0) {
    try {
      const indentation = Number.isInteger(Number(space)) ? Math.max(0, Math.min(10, Number(space))) : 0;
      return JSON.stringify({ version: 1, items: this.getItems() }, null, indentation);
    } catch (error) { this._reportError(error); return ""; }
  }

  exportData() {
    try { return Object.freeze({ version: 1, items: this.getItems() }); }
    catch (error) { this._reportError(error); return Object.freeze({ version: 1, items: Object.freeze([]) }); }
  }

  /** Import JSON text, an item array, or {items}; replace by default. */
  importItems(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const settings = isRecord(options) ? options : {};
      let parsed = input;
      if (typeof input === "string") parsed = JSON.parse(input);
      const incoming = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : null);
      if (!incoming) return false;
      const next = settings.replace === false ? new Map(this._items) : new Map();
      for (const candidate of incoming) {
        const item = normalizeItem(candidate);
        if (!item) continue;
        if (next.has(item.id)) next.delete(item.id);
        next.set(item.id, item);
      }
      while (next.size > this.maxItems) next.delete(next.keys().next().value);
      const previousCount = this._items.size;
      this._items = next;
      if (settings.silent !== true) this._commit("import", null, { importedCount: incoming.length, previousCount });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  importJSON(json, options) { return this.importItems(json, options); }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => false;
      this._subscribers.add(listener);
      let subscribed = true;
      return () => {
        try {
          if (!subscribed) return false;
          subscribed = false;
          return this._subscribers.delete(listener);
        } catch { return false; }
      };
    } catch (error) { this._reportError(error); return () => false; }
  }

  unsubscribe(listener) {
    try { return this._subscribers.delete(listener); }
    catch (error) { this._reportError(error); return false; }
  }

  setMaxItems(value, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const limit = normalizeLimit(value);
      this.maxItems = limit;
      let removedCount = 0;
      while (this._items.size > limit) {
        this._items.delete(this._items.keys().next().value);
        removedCount += 1;
      }
      if (removedCount && !(isRecord(options) && options.silent === true)) {
        this._commit("capacity", null, { maxItems: limit, removedCount });
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      if (isRecord(options) && options.clear === true) this._items.clear();
      this._subscribers.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a Watch Later manager without throwing in unsupported environments. */
export function createWatchLaterManager(options = {}) {
  try { return new WatchLaterManager(options); }
  catch { return null; }
}

export default Object.freeze({
  WatchLaterManager,
  createWatchLaterManager,
});
