const STORAGE_KEY_PREFIX = "trick-a4if-tube:offline-cache:v1:";
const memoryStorage = new Map();
const DEFAULT_MAX_ENTRIES = 500;
const MAX_ENTRIES_LIMIT = 100000;

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

function normalizeMaxEntries(value) {
  try {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_MAX_ENTRIES;
    return Math.min(MAX_ENTRIES_LIMIT, Math.max(0, Math.floor(number)));
  } catch {
    return DEFAULT_MAX_ENTRIES;
  }
}

function normalizeTtl(value, fallback = null) {
  try {
    if (value === null || value === undefined) return fallback;
    const ttl = Number(value);
    return Number.isFinite(ttl) && ttl >= 0 ? ttl : fallback;
  } catch {
    return fallback;
  }
}

function safeSerialize(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function byteLength(value) {
  try {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  } catch {
    // Use the portable fallback below.
  }
  try {
    return unescape(encodeURIComponent(value)).length;
  } catch {
    return String(value).length;
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

function normalizeStoredEntries(data, now = Date.now()) {
  try {
    const source = Array.isArray(data) ? data : [];
    const entries = new Map();
    for (const record of source) {
      if (!isRecord(record)) continue;
      const key = normalizeText(record.key, 2000);
      if (!key || !Object.prototype.hasOwnProperty.call(record, "value")) continue;
      const expiresAt = record.expiresAt === null || record.expiresAt === undefined
        ? null
        : Number(record.expiresAt);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) continue;
      const createdAtValue = Number(record.createdAt);
      const accessedAtValue = Number(record.accessedAt);
      entries.set(key, {
        key,
        value: record.value,
        createdAt: Number.isFinite(createdAtValue) ? createdAtValue : now,
        updatedAt: Number.isFinite(Number(record.updatedAt)) ? Number(record.updatedAt) : now,
        accessedAt: Number.isFinite(accessedAtValue) ? accessedAtValue : now,
        expiresAt,
      });
    }
    return entries;
  } catch {
    return new Map();
  }
}

/**
 * A namespaced JSON-compatible cache backed by localStorage where available,
 * with an in-memory fallback. TTL values are milliseconds; null means no expiry.
 */
export class OfflineCacheManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.namespace = normalizeText(settings.namespace, 256) || "default";
    this.storageKey = normalizeText(settings.storageKey, 1024)
      || `${STORAGE_KEY_PREFIX}${encodeURIComponent(this.namespace)}`;
    this.storage = resolveStorage(settings.storage);
    this.maxEntries = normalizeMaxEntries(settings.maxEntries ?? settings.maxSize ?? DEFAULT_MAX_ENTRIES);
    this.defaultTTL = normalizeTtl(settings.defaultTTL ?? settings.ttl, null);
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.lastError = null;
    this._entries = new Map();
    this._load();
    try {
      this.pruneExpired();
      this._enforceLimit();
    } catch (error) {
      this._reportError(error);
    }
  }

  /** Store a JSON-serializable value under a namespace-local key. */
  set(key, value, options = {}) {
    try {
      const normalizedKey = normalizeText(key, 2000);
      if (!normalizedKey || this.maxEntries === 0) return false;
      const serializedValue = safeSerialize(value);
      if (serializedValue === null) return false;
      // Validate round-trip and detach the cached value from caller mutations.
      let storedValue;
      try { storedValue = JSON.parse(serializedValue); } catch { return false; }

      const settings = typeof options === "number" ? { ttl: options } : (isRecord(options) ? options : {});
      const ttl = normalizeTtl(settings.ttl ?? settings.ttlMs, this.defaultTTL);
      const now = Date.now();
      const previous = this._entries.get(normalizedKey);
      const entry = {
        key: normalizedKey,
        value: storedValue,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        accessedAt: now,
        expiresAt: ttl === null ? null : now + ttl,
      };
      this._entries.set(normalizedKey, entry);
      this._enforceLimit();
      this._persist();
      this._notifyChange("set", normalizedKey);
      return this._entries.has(normalizedKey);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Retrieve a cached value, returning null when absent or expired. */
  get(key, fallback = null) {
    try {
      const normalizedKey = normalizeText(key, 2000);
      if (!normalizedKey) return fallback;
      const entry = this._entries.get(normalizedKey);
      if (!entry) return fallback;
      if (this._isExpired(entry, Date.now())) {
        this._entries.delete(normalizedKey);
        this._persist();
        this._notifyChange("expired", normalizedKey);
        return fallback;
      }
      entry.accessedAt = Date.now();
      this._persist();
      return entry.value;
    } catch (error) {
      this._reportError(error);
      return fallback;
    }
  }

  /** Check whether a non-expired cache entry exists. */
  has(key) {
    try {
      const normalizedKey = normalizeText(key, 2000);
      if (!normalizedKey) return false;
      const entry = this._entries.get(normalizedKey);
      if (!entry) return false;
      if (!this._isExpired(entry, Date.now())) return true;
      this._entries.delete(normalizedKey);
      this._persist();
      this._notifyChange("expired", normalizedKey);
      return false;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Delete one cache entry; returns true only when an entry existed. */
  delete(key) {
    try {
      const normalizedKey = normalizeText(key, 2000);
      if (!normalizedKey || !this._entries.has(normalizedKey)) return false;
      this._entries.delete(normalizedKey);
      this._persist();
      this._notifyChange("delete", normalizedKey);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Clear all entries in this namespace without affecting other namespaces. */
  clear() {
    try {
      const hadEntries = this._entries.size > 0;
      this._entries.clear();
      this._persist();
      if (hadEntries) this._notifyChange("clear", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Remove expired entries and return the number removed. */
  pruneExpired(now = Date.now()) {
    try {
      const timestamp = Number(now);
      if (!Number.isFinite(timestamp)) return 0;
      let removed = 0;
      for (const [key, entry] of this._entries) {
        if (this._isExpired(entry, timestamp)) {
          this._entries.delete(key);
          removed += 1;
        }
      }
      if (removed > 0) {
        this._persist();
        this._notifyChange("prune", null);
      }
      return removed;
    } catch (error) {
      this._reportError(error);
      return 0;
    }
  }

  /** Update the maximum retained entries, immediately evicting excess entries. */
  setMaxEntries(maxEntries) {
    try {
      const value = Number(maxEntries);
      if (!Number.isFinite(value) || value < 0) return false;
      this.maxEntries = normalizeMaxEntries(value);
      this._enforceLimit();
      this._persist();
      this._notifyChange("limit", null);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Return an immutable cache statistics snapshot. */
  getStats() {
    try {
      const now = Date.now();
      let activeEntries = 0;
      let expiredEntries = 0;
      for (const entry of this._entries.values()) {
        if (this._isExpired(entry, now)) expiredEntries += 1;
        else activeEntries += 1;
      }
      const serialized = safeSerialize(this._serializeEntries());
      const sizeBytes = serialized === null ? 0 : byteLength(serialized);
      return Object.freeze({
        namespace: this.namespace,
        entries: this._entries.size,
        activeEntries,
        expiredEntries,
        maxEntries: this.maxEntries,
        sizeBytes,
        storageKey: this.storageKey,
        persistent: Boolean(this.storage),
      });
    } catch {
      return Object.freeze({
        namespace: this.namespace,
        entries: 0,
        activeEntries: 0,
        expiredEntries: 0,
        maxEntries: this.maxEntries,
        sizeBytes: 0,
        storageKey: this.storageKey,
        persistent: false,
      });
    }
  }

  /** Alias for getStats(). */
  stats() {
    try { return this.getStats(); } catch { return null; }
  }

  /** Current entry count, including entries not yet pruned. */
  get size() {
    try { return this._entries.size; } catch { return 0; }
  }

  _isExpired(entry, now) {
    try { return entry?.expiresAt !== null && entry?.expiresAt !== undefined && entry.expiresAt <= now; } catch { return true; }
  }

  _enforceLimit() {
    try {
      while (this._entries.size > this.maxEntries) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this._entries) {
          const time = Number(entry.accessedAt ?? entry.updatedAt ?? entry.createdAt);
          if (time < oldestTime) {
            oldestTime = time;
            oldestKey = key;
          }
        }
        if (oldestKey === null) break;
        this._entries.delete(oldestKey);
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _serializeEntries() {
    try {
      return [...this._entries.values()].map((entry) => ({
        key: entry.key,
        value: entry.value,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        accessedAt: entry.accessedAt,
        expiresAt: entry.expiresAt,
      }));
    } catch {
      return [];
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
      this._entries = normalizeStoredEntries(records);
    } catch (error) {
      this._entries = new Map();
      this._reportError(error);
    }
  }

  _persist() {
    try {
      const value = JSON.stringify({ version: 1, namespace: this.namespace, entries: this._serializeEntries() });
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

  _notifyChange(type, key) {
    try {
      if (this.onChange) this.onChange(Object.freeze({ type, key: key ?? null, stats: this.getStats() }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Offline cache operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt cache operations.
    }
  }
}

/** Create a cache manager without throwing when browser storage is unavailable. */
export function createOfflineCacheManager(options = {}) {
  try {
    return new OfflineCacheManager(options);
  } catch {
    return null;
  }
}

export const OFFLINE_CACHE_DEFAULTS = Object.freeze({
  maxEntries: DEFAULT_MAX_ENTRIES,
  storageKeyPrefix: STORAGE_KEY_PREFIX,
});

export default Object.freeze({
  OFFLINE_CACHE_DEFAULTS,
  OfflineCacheManager,
  createOfflineCacheManager,
});
