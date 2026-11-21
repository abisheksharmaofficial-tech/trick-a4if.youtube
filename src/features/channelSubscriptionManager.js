const STORAGE_KEY = "trick-a4if-tube:channel-subscriptions";
const NOTIFY_MODES = Object.freeze(["all", "personalized", "none"]);
const DEFAULT_MAX_SUBSCRIPTIONS = 5000;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = 2048) {
  try { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
  catch { return ""; }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.id ?? value.channelId ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeCount(value) {
  try {
    if (value == null || value === "") return 0;
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch { return 0; }
}

function normalizeNotifyMode(value, fallback = "all") {
  try {
    const mode = normalizeText(value, 32).toLowerCase();
    return NOTIFY_MODES.includes(mode) ? mode : fallback;
  } catch { return fallback; }
}

function normalizeChannel(input, now = Date.now(), defaults = {}) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeId(input.id ?? input.channelId ?? input.key);
    if (!id) return null;
    const subscribedValue = Number(input.subscribedAt ?? input.subscribedAtTimestamp);
    return Object.freeze({
      id,
      name: normalizeText(input.name ?? input.title, 1024),
      handle: normalizeText(input.handle ?? input.username, 512),
      avatar: normalizeText(input.avatar ?? input.avatarUrl ?? input.thumbnail, 8192),
      category: normalizeText(input.category, 512),
      subscriberCount: normalizeCount(input.subscriberCount ?? input.subscribers),
      notifyMode: normalizeNotifyMode(input.notifyMode ?? defaults.notifyMode, "all"),
      subscribedAt: Number.isFinite(subscribedValue) && subscribedValue >= 0 ? subscribedValue : now,
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
    return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_MAX_SUBSCRIPTIONS;
  } catch { return DEFAULT_MAX_SUBSCRIPTIONS; }
}

function normalizeSort(value) {
  try {
    const sort = normalizeText(value, 32).toLowerCase();
    return ["subscribed-asc", "subscribed-desc", "name-asc", "name-desc", "category-asc", "category-desc", "subscribers-asc", "subscribers-desc"].includes(sort)
      ? sort : "subscribed-desc";
  } catch { return "subscribed-desc"; }
}

/**
 * Manage channel subscriptions with localStorage persistence and a process-
 * local in-memory fallback. This manager does not contact external services.
 */
export class ChannelSubscriptionManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.maxSubscriptions = normalizeLimit(settings.maxSubscriptions ?? settings.limit ?? DEFAULT_MAX_SUBSCRIPTIONS);
    this.defaultNotifyMode = normalizeNotifyMode(settings.notifyMode, "all");
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._channels = new Map();
    this._listeners = new Set();
    this._load();
    if (Array.isArray(settings.channels) && this._channels.size === 0) {
      this.importChannels(settings.channels, { replace: true, silent: true });
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Channel subscription operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Keep error handlers isolated. */ }
    } catch { /* Error reporting must not disrupt operations. */ }
  }

  _load() {
    try {
      let serialized = null;
      try { serialized = this.storage?.getItem(this.storageKey); }
      catch (error) { this._reportError(error); }
      if (typeof serialized !== "string" || !serialized) return false;
      const parsed = JSON.parse(serialized);
      const channels = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.channels) ? parsed.channels : null);
      if (!channels) return false;
      this._channels = this._normalizeCollection(channels);
      return true;
    } catch (error) {
      this._reportError(error);
      this._channels = new Map();
      return false;
    }
  }

  _normalizeCollection(channels) {
    try {
      const result = new Map();
      if (!Array.isArray(channels)) return result;
      for (const candidate of channels) {
        const channel = normalizeChannel(candidate, Date.now(), { notifyMode: this.defaultNotifyMode });
        if (!channel) continue;
        if (result.has(channel.id)) result.delete(channel.id);
        result.set(channel.id, channel);
      }
      while (result.size > this.maxSubscriptions) result.delete(result.keys().next().value);
      return result;
    } catch (error) { this._reportError(error); return new Map(); }
  }

  _persist() {
    try {
      if (!this.storage || typeof this.storage.setItem !== "function") return false;
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, channels: this.getSubscriptions() }));
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, channel = null, details = {}) {
    try {
      const event = Object.freeze({ type, channel, channels: this.getSubscriptions(), count: this._channels.size, ...details });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _commit(type, channel = null, details = {}) {
    try {
      this._persist();
      this._notify(type, channel, details);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Subscribe to a channel. Returns the normalized channel, or null on failure. */
  subscribe(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxSubscriptions === 0) return null;
      const settings = isRecord(options) ? options : {};
      const id = normalizeId(input);
      if (!id) return null;
      const existing = this._channels.get(id);
      if (existing && settings.updateExisting !== true) return existing;
      if (!existing && this._channels.size >= this.maxSubscriptions) {
        if (settings.evictOldest !== true) return null;
        this._channels.delete(this._channels.keys().next().value);
      }
      const source = isRecord(input) ? input : { ...settings, id };
      const normalized = normalizeChannel({ ...source, id }, existing?.subscribedAt ?? Date.now(), {
        notifyMode: settings.notifyMode ?? this.defaultNotifyMode,
      });
      if (!normalized) return null;
      const channel = existing
        ? Object.freeze({ ...existing, ...normalized, subscribedAt: existing.subscribedAt })
        : normalized;
      this._channels.delete(id);
      this._channels.set(id, channel);
      this._commit(existing ? "update" : "subscribe", channel);
      return channel;
    } catch (error) { this._reportError(error); return null; }
  }

  addSubscription(channel, options) { return this.subscribe(channel, options); }

  unsubscribe(channelOrId) {
    try {
      if (this.isDestroyed) return false;
      const id = normalizeId(channelOrId);
      if (!id || !this._channels.has(id)) return false;
      const channel = this._channels.get(id);
      this._channels.delete(id);
      this._commit("unsubscribe", channel);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeSubscription(channelOrId) { return this.unsubscribe(channelOrId); }

  toggleSubscription(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const id = normalizeId(input);
      if (id && this._channels.has(id)) return this.unsubscribe(id) ? false : this._channels.get(id) ?? false;
      return this.subscribe(input, options) ?? false;
    } catch (error) { this._reportError(error); return false; }
  }

  toggle(input, options) { return this.toggleSubscription(input, options); }

  isSubscribed(channelOrId) {
    try { return this._channels.has(normalizeId(channelOrId)); }
    catch { return false; }
  }

  has(channelOrId) { return this.isSubscribed(channelOrId); }

  getSubscription(channelOrId) {
    try { return this._channels.get(normalizeId(channelOrId)) ?? null; }
    catch (error) { this._reportError(error); return null; }
  }

  setNotifyMode(channelOrId, notifyMode) {
    try {
      if (this.isDestroyed) return false;
      const id = normalizeId(channelOrId);
      const current = this._channels.get(id);
      const mode = normalizeNotifyMode(notifyMode, "");
      if (!current || !NOTIFY_MODES.includes(mode)) return false;
      const updated = Object.freeze({ ...current, notifyMode: mode });
      this._channels.set(id, updated);
      this._commit("notify-mode", updated);
      return updated;
    } catch (error) { this._reportError(error); return false; }
  }

  getSubscriptions(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let channels = Array.from(this._channels.values());
      const query = normalizeText(settings.query ?? settings.search, 1024).toLocaleLowerCase();
      if (query) channels = channels.filter((channel) => [channel.id, channel.name, channel.handle, channel.category]
        .some((value) => value.toLocaleLowerCase().includes(query)));
      const category = normalizeText(settings.category, 512).toLocaleLowerCase();
      if (category) channels = channels.filter((channel) => channel.category.toLocaleLowerCase() === category);
      const notifyMode = normalizeNotifyMode(settings.notifyMode, "");
      if (NOTIFY_MODES.includes(notifyMode)) channels = channels.filter((channel) => channel.notifyMode === notifyMode);
      const sort = normalizeSort(settings.sort);
      channels.sort((left, right) => {
        switch (sort) {
          case "subscribed-asc": return left.subscribedAt - right.subscribedAt || left.id.localeCompare(right.id);
          case "name-asc": return left.name.localeCompare(right.name) || left.subscribedAt - right.subscribedAt;
          case "name-desc": return right.name.localeCompare(left.name) || right.subscribedAt - left.subscribedAt;
          case "category-asc": return left.category.localeCompare(right.category) || left.name.localeCompare(right.name);
          case "category-desc": return right.category.localeCompare(left.category) || right.name.localeCompare(left.name);
          case "subscribers-asc": return left.subscriberCount - right.subscriberCount || left.name.localeCompare(right.name);
          case "subscribers-desc": return right.subscriberCount - left.subscriberCount || left.name.localeCompare(right.name);
          default: return right.subscribedAt - left.subscribedAt || right.id.localeCompare(left.id);
        }
      });
      if (settings.limit != null) {
        const limit = Number(settings.limit);
        if (Number.isFinite(limit) && limit >= 0) channels = channels.slice(0, Math.floor(limit));
      }
      return Object.freeze(channels);
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  query(options = {}) { return this.getSubscriptions(options); }
  get count() { return this._channels.size; }

  exportJSON(space = 0) {
    try {
      const indentation = Number.isInteger(Number(space)) ? Math.min(10, Math.max(0, Number(space))) : 0;
      return JSON.stringify({ version: 1, channels: this.getSubscriptions() }, null, indentation);
    } catch (error) { this._reportError(error); return ""; }
  }

  exportData() {
    try { return Object.freeze({ version: 1, channels: this.getSubscriptions() }); }
    catch (error) { this._reportError(error); return Object.freeze({ version: 1, channels: Object.freeze([]) }); }
  }

  /** Import JSON, an array, or an object containing channels. Replace by default. */
  importChannels(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const settings = isRecord(options) ? options : {};
      let parsed = input;
      if (typeof input === "string") parsed = JSON.parse(input);
      const incoming = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.channels) ? parsed.channels : null);
      if (!incoming) return false;
      const next = settings.replace === false ? new Map(this._channels) : new Map();
      for (const candidate of incoming) {
        const channel = normalizeChannel(candidate, Date.now(), { notifyMode: this.defaultNotifyMode });
        if (!channel) continue;
        if (next.has(channel.id)) next.delete(channel.id);
        next.set(channel.id, channel);
      }
      while (next.size > this.maxSubscriptions) next.delete(next.keys().next().value);
      const previousCount = this._channels.size;
      this._channels = next;
      if (settings.silent !== true) this._commit("import", null, { importedCount: incoming.length, previousCount });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  importJSON(json, options) { return this.importChannels(json, options); }

  subscribeToChanges(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => false;
      this._listeners.add(listener);
      let active = true;
      return () => {
        try {
          if (!active) return false;
          active = false;
          return this._listeners.delete(listener);
        } catch { return false; }
      };
    } catch (error) { this._reportError(error); return () => false; }
  }

  subscribeChanges(listener) { return this.subscribeToChanges(listener); }
  onChangeListener(listener) { return this.subscribeToChanges(listener); }

  unsubscribeFromChanges(listener) {
    try { return this._listeners.delete(listener); }
    catch (error) { this._reportError(error); return false; }
  }

  setMaxSubscriptions(value, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const limit = normalizeLimit(value);
      this.maxSubscriptions = limit;
      let removedCount = 0;
      while (this._channels.size > limit) {
        this._channels.delete(this._channels.keys().next().value);
        removedCount += 1;
      }
      if (removedCount && !(isRecord(options) && options.silent === true)) {
        this._commit("capacity", null, { maxSubscriptions: limit, removedCount });
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (this._channels.size === 0) return true;
      const previousCount = this._channels.size;
      this._channels.clear();
      this._commit("clear", null, { previousCount });
      if (isRecord(options) && options.removeStorage === true) {
        try { this.storage?.removeItem?.(this.storageKey); } catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      if (isRecord(options) && options.clear === true) this._channels.clear();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a channel subscription manager without throwing in restricted environments. */
export function createChannelSubscriptionManager(options = {}) {
  try { return new ChannelSubscriptionManager(options); }
  catch { return null; }
}

export { NOTIFY_MODES };

export default Object.freeze({
  NOTIFY_MODES,
  ChannelSubscriptionManager,
  createChannelSubscriptionManager,
});
