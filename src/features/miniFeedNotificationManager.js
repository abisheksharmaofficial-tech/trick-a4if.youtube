const STORAGE_KEY = "trick-a4if-tube:mini-feed-notifications:v1";
const memoryStorage = new Map();
const DEFAULT_MAX_ITEMS = 200;
const MAX_ITEMS = 10000;
const MAX_ID_LENGTH = 512;
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
    if (isRecord(value)) return normalizeText(value.id ?? value.notificationId ?? value.key, MAX_ID_LENGTH);
    return normalizeText(value, MAX_ID_LENGTH);
  } catch { return ""; }
}

function normalizeLimit(value, fallback = DEFAULT_MAX_ITEMS) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_ITEMS, Math.max(0, Math.floor(number))) : fallback;
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

function cloneJson(value, fallback = null) {
  try {
    if (value === undefined) return fallback;
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch { return fallback; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function createNotificationId() {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
  } catch { /* Use an instance-local counter if crypto is unavailable. */ }
  return "";
}

function normalizeNotification(input, options = {}) {
  try {
    if (!isRecord(input)) return null;
    const now = options.now ?? Date.now();
    const createdAt = normalizeTimestamp(input.createdAt, now);
    const metadata = cloneJson(input.metadata, {});
    return Object.freeze({
      id: normalizeId(input.id ?? input.notificationId) || options.createId?.() || "",
      type: normalizeText(input.type, 100).toLowerCase() || "general",
      title: normalizeText(input.title, 1000),
      message: normalizeText(input.message, MAX_TEXT_LENGTH),
      channel: normalizeText(input.channel ?? input.channelName, 1000),
      videoId: normalizeText(input.videoId ?? input.video, MAX_ID_LENGTH),
      url: normalizeText(input.url, 4096),
      read: input.read === true,
      createdAt,
      metadata: isRecord(metadata) || Array.isArray(metadata) ? Object.freeze(metadata) : Object.freeze({}),
    });
  } catch { return null; }
}

function normalizeSearch(value) {
  try { return normalizeText(value, 1000).toLocaleLowerCase(); }
  catch { return ""; }
}

/**
 * Manage a bounded local mini-feed of caller-provided notifications. Items are
 * deduplicated by ID (or an explicit dedupeKey), persisted locally when possible,
 * and kept usable in memory if storage is unavailable. No notifications are
 * fetched, generated, or simulated by this manager.
 */
export class MiniFeedNotificationManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxItems = normalizeLimit(settings.maxItems ?? settings.limit);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._idCounter = 0;
      this._items = [];
      this._dedupeKeys = new Map();
      this._subscribers = new Set();
      this._load();
      if (Array.isArray(settings.notifications) && this._items.length === 0) {
        this.importJSON(settings.notifications, { replace: true, silent: true });
      }
    } catch {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxItems = DEFAULT_MAX_ITEMS;
      this.onChange = null;
      this.onError = null;
      this.lastError = null;
      this.isDestroyed = false;
      this._idCounter = 0;
      this._items = [];
      this._dedupeKeys = new Map();
      this._subscribers = new Set();
    }
  }

  /** Add a notification; repeated IDs or explicit dedupe keys update in place. */
  add(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxItems === 0 || !isRecord(input)) return null;
      const settings = isRecord(options) ? options : {};
      const now = Date.now();
      const dedupeKey = normalizeText(settings.dedupeKey ?? input.dedupeKey, MAX_ID_LENGTH);
      const providedId = normalizeId(input.id ?? input.notificationId);
      const existing = (providedId && this._items.find((item) => item.id === providedId))
        || (dedupeKey && this._findByDedupeKey(dedupeKey));
      const notification = normalizeNotification({
        ...(existing ?? {}),
        ...input,
        id: providedId || existing?.id || this._newId(),
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        read: input.read ?? existing?.read ?? false,
      }, { now, createId: () => this._newId() });
      if (!notification?.id) return null;

      if (existing) {
        const index = this._items.findIndex((item) => item.id === existing.id);
        if (index < 0) return null;
        this._items[index] = notification;
        if (dedupeKey) this._dedupeKeys.set(dedupeKey, notification.id);
        this._persist();
        if (settings.silent !== true) this._notify("updated", notification);
        return notification;
      }
      this._items.unshift(notification);
      if (dedupeKey) this._dedupeKeys.set(dedupeKey, notification.id);
      this._enforceLimit();
      this._rebuildDedupeKeys();
      this._persist();
      if (settings.silent !== true) this._notify("added", notification);
      return notification;
    } catch (error) { this._reportError(error); return null; }
  }

  addNotification(input, options) { return this.add(input, options); }

  update(id, changes = {}, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(changes)) return null;
      const normalizedId = normalizeId(id);
      const index = this._items.findIndex((item) => item.id === normalizedId);
      if (!normalizedId || index < 0) return null;
      const previous = this._items[index];
      const updated = normalizeNotification({ ...previous, ...changes, id: previous.id, createdAt: previous.createdAt,
        updatedAt: Date.now() }, { createId: () => previous.id });
      if (!updated) return null;
      this._items[index] = updated;
      this._persist();
      if (options?.silent !== true) this._notify("updated", updated);
      return updated;
    } catch (error) { this._reportError(error); return null; }
  }

  updateNotification(id, changes, options) { return this.update(id, changes, options); }

  dismiss(id, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeId(id);
      const index = this._items.findIndex((item) => item.id === normalized);
      if (!normalized || index < 0) return false;
      const [removed] = this._items.splice(index, 1);
      this._rebuildDedupeKeys();
      this._persist();
      if (options?.silent !== true) this._notify("dismissed", removed);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  dismissNotification(id, options) { return this.dismiss(id, options); }
  remove(id, options) { return this.dismiss(id, options); }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (!this._items.length) return true;
      this._items = [];
      this._dedupeKeys.clear();
      this._persist();
      if (options?.silent !== true) this._notify("cleared", null);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clearNotifications(options) { return this.clear(options); }

  markRead(id, read = true, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeId(id);
      const index = this._items.findIndex((item) => item.id === normalized);
      if (!normalized || index < 0) return false;
      const current = this._items[index];
      const value = typeof read === "boolean" ? read : true;
      if (current.read === value) return true;
      const updated = Object.freeze({ ...current, read: value });
      this._items[index] = updated;
      this._persist();
      if (options?.silent !== true) this._notify(value ? "read" : "unread", updated);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  markAsRead(id, options) { return this.markRead(id, true, options); }
  markAsUnread(id, options) { return this.markRead(id, false, options); }

  markAllRead(read = true, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const nextRead = typeof read === "boolean" ? read : true;
      const changed = this._items.filter((item) => item.read !== nextRead);
      if (!changed.length) return true;
      const ids = new Set(changed.map((item) => item.id));
      this._items = this._items.map((item) => ids.has(item.id) ? Object.freeze({ ...item, read: nextRead }) : item);
      this._persist();
      if (options?.silent !== true) this._notify(nextRead ? "all-read" : "all-unread", null);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  markAllAsRead(options) { return this.markAllRead(true, options); }
  markAllAsUnread(options) { return this.markAllRead(false, options); }

  getNotifications(options = {}) {
    try {
      const settings = typeof options === "string" ? { search: options } : (isRecord(options) ? options : {});
      let items = this._items.slice();
      if (typeof settings.read === "boolean") items = items.filter((item) => item.read === settings.read);
      const type = normalizeSearch(settings.type);
      if (type) items = items.filter((item) => item.type.toLocaleLowerCase() === type);
      const channel = normalizeSearch(settings.channel);
      if (channel) items = items.filter((item) => item.channel.toLocaleLowerCase() === channel);
      const videoId = normalizeId(settings.videoId);
      if (videoId) items = items.filter((item) => item.videoId === videoId);
      const query = normalizeSearch(settings.search ?? settings.query);
      if (query) items = items.filter((item) => [item.id, item.type, item.title, item.message, item.channel, item.videoId, item.url]
        .some((value) => value.toLocaleLowerCase().includes(query))
        || JSON.stringify(item.metadata).toLocaleLowerCase().includes(query));
      const since = normalizeTimestampBound(settings.since ?? settings.after);
      const before = normalizeTimestampBound(settings.before);
      if (since !== null) items = items.filter((item) => item.createdAt >= since);
      if (before !== null) items = items.filter((item) => item.createdAt <= before);
      if (typeof settings.predicate === "function") items = items.filter((item) => settings.predicate(item));
      const sort = normalizeText(settings.sortBy ?? settings.sort, 32).toLowerCase();
      if (sort === "oldest" || sort === "created-asc") items.sort((a, b) => a.createdAt - b.createdAt);
      else if (sort === "title") items.sort((a, b) => a.title.localeCompare(b.title));
      else if (sort === "type") items.sort((a, b) => a.type.localeCompare(b.type));
      else items.sort((a, b) => b.createdAt - a.createdAt);
      if (settings.order === "asc") items.reverse();
      const offset = normalizeLimit(settings.offset ?? 0, 0);
      const limit = settings.limit === undefined ? items.length : normalizeLimit(settings.limit, 0);
      return Object.freeze(items.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  list(options = {}) { return this.getNotifications(options); }
  search(query, options = {}) { return this.getNotifications({ ...(isRecord(options) ? options : {}), search: query }); }
  get(id) {
    try { const normalized = normalizeId(id); return this._items.find((item) => item.id === normalized) ?? null; }
    catch { return null; }
  }

  get unreadCount() {
    try { return this._items.reduce((count, item) => count + (item.read ? 0 : 1), 0); }
    catch { return 0; }
  }

  getUnreadCount() { return this.unreadCount; }
  get size() { try { return this._items.length; } catch { return 0; } }

  setMaxItems(value) {
    try {
      if (this.isDestroyed) return false;
      const limit = normalizeLimit(value, -1);
      if (limit < 0) return false;
      this.maxItems = limit;
      this._enforceLimit();
      this._rebuildDedupeKeys();
      this._persist();
      this._notify("limit-changed", null);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 1, exportedAt: Date.now(), notifications: this._items };
      return settings.asObject === true ? Object.freeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { notifications: payload };
      if (!isRecord(payload)) return 0;
      const records = payload.notifications ?? payload.items ?? payload.entries;
      if (!Array.isArray(records)) return 0;
      const byId = new Map(settings.replace === true ? [] : this._items.map((item) => [item.id, item]));
      let imported = 0;
      for (const candidate of records) {
        const notification = normalizeNotification(candidate, { createId: () => this._newId() });
        if (!notification?.id) continue;
        byId.set(notification.id, notification);
        imported += 1;
      }
      this._items = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, this.maxItems);
      this._rebuildDedupeKeys();
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

  destroy() {
    try { this.isDestroyed = true; this._subscribers.clear(); this.storage = null; this.onChange = null; this.onError = null; return true; }
    catch { return false; }
  }

  _newId() {
    try {
      const cryptoId = createNotificationId();
      if (cryptoId) return cryptoId;
    } catch { /* Use a counter when cryptographic IDs are unavailable. */ }
    this._idCounter += 1;
    return `notification-${Date.now().toString(36)}-${this._idCounter.toString(36)}`;
  }

  _findByDedupeKey(key) {
    try {
      const id = this._dedupeKeys.get(key);
      return id ? this._items.find((item) => item.id === id) ?? null : null;
    } catch { return null; }
  }

  _rebuildDedupeKeys() {
    try {
      const present = new Set(this._items.map((item) => item.id));
      for (const [key, id] of this._dedupeKeys) if (!present.has(id)) this._dedupeKeys.delete(key);
    } catch { this._dedupeKeys.clear(); }
  }

  _enforceLimit() {
    try { if (this._items.length > this.maxItems) this._items.length = this.maxItems; }
    catch (error) { this._reportError(error); }
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
      const records = Array.isArray(payload) ? payload : payload?.notifications;
      if (!Array.isArray(records)) return;
      const byId = new Map();
      for (const candidate of records) {
        const notification = normalizeNotification(candidate, { createId: () => this._newId() });
        if (notification?.id) byId.set(notification.id, notification);
      }
      this._items = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, this.maxItems);
    } catch (error) { this._items = []; this._reportError(error); }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, notifications: this._items });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, notification) {
    try {
      const event = Object.freeze({ type, notification: notification ?? null, notifications: Object.freeze(this._items.slice()), unreadCount: this.unreadCount });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Mini-feed notification operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate error handlers. */ }
    } catch { /* Error handling must not interrupt feed operations. */ }
  }
}

function normalizeTimestampBound(value) {
  try {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch { return null; }
}

/** Create a local mini-feed notification manager without throwing on setup. */
export function createMiniFeedNotificationManager(options = {}) {
  try { return new MiniFeedNotificationManager(options); }
  catch { return null; }
}

export default Object.freeze({ MiniFeedNotificationManager, createMiniFeedNotificationManager });
