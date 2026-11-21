const STORAGE_KEY = "trick-a4if-tube:feature-registry-hub:v1";
const memoryStorage = new Map();
const MAX_FEATURES = 1000;
const MAX_TEXT_LENGTH = 4096;
const MAX_METADATA_LENGTH = 100000;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, limit);
  } catch { return ""; }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
}

function normalizeLimit(value, fallback = MAX_FEATURES) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_FEATURES, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function cloneMetadata(value) {
  try {
    if (value === null || value === undefined) return {};
    if (!isRecord(value) && !Array.isArray(value)) return {};
    const serialized = JSON.stringify(value, (key, entry) => {
      if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") return undefined;
      if (typeof entry === "number" && !Number.isFinite(entry)) return null;
      return entry;
    });
    if (typeof serialized !== "string" || serialized.length > MAX_METADATA_LENGTH) return {};
    const result = JSON.parse(serialized);
    return result && typeof result === "object" ? result : {};
  } catch { return {}; }
}

function freezeDeep(value) {
  try {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freezeDeep(child);
    }
    return value;
  } catch { return value; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeVersion(value) {
  try { return normalizeText(value, 256); }
  catch { return ""; }
}

function getMethodNames(instance) {
  try {
    if (instance === null || instance === undefined) return Object.freeze([]);
    const names = new Set();
    let current = instance;
    let depth = 0;
    while (current && current !== Object.prototype && depth < 8) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (key === "constructor" || key.startsWith("_") || names.has(key)) continue;
        let descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(current, key); } catch { continue; }
        if (descriptor && typeof descriptor.value === "function") names.add(key);
      }
      try { current = Object.getPrototypeOf(current); } catch { break; }
      depth += 1;
    }
    return Object.freeze([...names].sort());
  } catch { return Object.freeze([]); }
}

function getCapabilities(instance) {
  try {
    if (!instance) return Object.freeze([]);
    const supplied = instance.capabilities;
    if (Array.isArray(supplied)) return Object.freeze([...new Set(supplied.map((item) => normalizeText(item, 256)).filter(Boolean))].sort());
    if (isRecord(supplied)) return Object.freeze(Object.keys(supplied).filter((key) => supplied[key] === true).sort());
    return getMethodNames(instance);
  } catch { return Object.freeze([]); }
}

function getSafeStatus(instance) {
  try {
    const statusValue = typeof instance?.getStatus === "function" ? instance.getStatus() : instance?.status;
    if (typeof statusValue === "string" || typeof statusValue === "number" || typeof statusValue === "boolean" || statusValue == null) {
      return statusValue ?? null;
    }
    return cloneMetadata(statusValue);
  } catch (error) { return Object.freeze({ error: normalizeText(error?.message, 1000) || "Status inspection failed" }); }
}

function normalizePersistedRecord(input, now = Date.now()) {
  try {
    if (!isRecord(input)) return null;
    const name = normalizeText(input.name, 512);
    if (!name) return null;
    return Object.freeze({
      name,
      version: normalizeVersion(input.version),
      enabled: input.enabled !== false,
      metadata: freezeDeep(cloneMetadata(input.metadata)),
      registeredAt: normalizeTimestamp(input.registeredAt, now),
      updatedAt: normalizeTimestamp(input.updatedAt, now),
    });
  } catch { return null; }
}

/**
 * Registry for caller-provided feature modules. Persistence stores registry
 * settings and metadata only; live instances are never serialized or recreated.
 */
export class FeatureRegistryHub {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxFeatures = normalizeLimit(settings.maxFeatures ?? settings.limit);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._features = new Map();
      this._listeners = new Set();
      this._persisted = new Map();
      this._load();
      const initial = Array.isArray(settings.features) ? settings.features : [];
      for (const feature of initial.slice(0, this.maxFeatures)) this.register(feature, { silent: true, persist: false });
    } catch (error) {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxFeatures = MAX_FEATURES;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._features = new Map();
      this._listeners = new Set();
      this._persisted = new Map();
    }
  }

  _reportError(error, featureName = "") {
    try {
      const original = error instanceof Error ? error : new Error("Feature registry operation failed.");
      this.lastError = original;
      try { this.onError?.(original, this, normalizeText(featureName, 512) || null); } catch { /* Keep error handlers isolated. */ }
    } catch { /* Error handling must not interrupt registry operations. */ }
  }

  _load() {
    try {
      let serialized = null;
      if (this.storage) {
        try { serialized = this.storage.getItem(this.storageKey); }
        catch (error) { this._reportError(error); }
      }
      if (serialized == null) serialized = memoryStorage.get(this.storageKey) ?? null;
      if (typeof serialized !== "string" || !serialized) return false;
      const payload = JSON.parse(serialized);
      const records = Array.isArray(payload) ? payload : payload?.features;
      if (!Array.isArray(records)) return false;
      for (const value of records.slice(0, MAX_FEATURES)) {
        const record = normalizePersistedRecord(value);
        if (record) this._persisted.set(record.name, record);
      }
      return true;
    } catch (error) { this._reportError(error); this._persisted.clear(); return false; }
  }

  _persist() {
    try {
      const records = [...this._features.values()].map((feature) => ({
        name: feature.name,
        version: feature.version,
        enabled: feature.enabled,
        metadata: feature.metadata,
        registeredAt: feature.registeredAt,
        updatedAt: feature.updatedAt,
      }));
      const serialized = JSON.stringify({ version: 1, features: records });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      this._persisted = new Map(records.map((record) => [record.name, record]));
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, feature = null, details = {}) {
    try {
      const event = Object.freeze({ type, feature: feature ? this._publicRecord(feature) : null, features: this.list(), count: this._features.size, ...details });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _publicRecord(record, options = {}) {
    try {
      const includeInstance = options.includeInstance === true;
      return Object.freeze({
        name: record.name,
        ...(includeInstance ? { instance: record.instance } : {}),
        version: record.version,
        enabled: record.enabled,
        metadata: freezeDeep(cloneMetadata(record.metadata)),
        registeredAt: record.registeredAt,
        updatedAt: record.updatedAt,
        capabilities: getCapabilities(record.instance),
        methods: getMethodNames(record.instance),
      });
    } catch (error) { this._reportError(error, record?.name); return null; }
  }

  _normalizeRegistration(input, options = {}, previous = null) {
    try {
      const source = isRecord(input) ? input : {};
      const settings = isRecord(options) ? options : {};
      const name = normalizeText(source.name ?? settings.name ?? previous?.name, 512);
      if (!name) return null;
      const instance = source.instance ?? settings.instance ?? previous?.instance ?? null;
      const saved = this._persisted.get(name);
      const now = Date.now();
      const enabled = typeof settings.enabled === "boolean" ? settings.enabled
        : typeof source.enabled === "boolean" ? source.enabled
          : previous ? previous.enabled : (saved?.enabled ?? true);
      const metadataInput = source.metadata ?? settings.metadata ?? previous?.metadata ?? saved?.metadata;
      const metadata = freezeDeep(cloneMetadata(metadataInput));
      return {
        name,
        instance,
        version: normalizeVersion(source.version ?? settings.version ?? previous?.version ?? saved?.version),
        enabled,
        metadata,
        registeredAt: previous?.registeredAt ?? normalizeTimestamp(source.registeredAt ?? saved?.registeredAt, now),
        updatedAt: now,
      };
    } catch (error) { this._reportError(error); return null; }
  }

  /** Register a module object or descriptor `{name, instance, ...}`. */
  register(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxFeatures === 0) return null;
      const settings = isRecord(options) ? options : {};
      const descriptor = isRecord(input) && (Object.hasOwn(input, "instance") || Object.hasOwn(input, "name"))
        ? input
        : { ...(isRecord(settings) ? settings : {}), name: settings.name, instance: input };
      const name = normalizeText(descriptor.name ?? settings.name, 512);
      if (!name) return null;
      const previous = this._features.get(name) ?? null;
      if (previous && settings.replace !== true) return this._publicRecord(previous, { includeInstance: true });
      if (!previous && this._features.size >= this.maxFeatures) return null;
      const record = this._normalizeRegistration(descriptor, settings, previous);
      if (!record) return null;
      this._features.set(name, record);
      this._persist();
      if (settings.silent !== true) this._notify(previous ? "updated" : "registered", record);
      return this._publicRecord(record, { includeInstance: true });
    } catch (error) { this._reportError(error); return null; }
  }

  registerFeature(input, options) { return this.register(input, options); }

  get(name) {
    try {
      const record = this._features.get(normalizeText(name, 512));
      return record ? this._publicRecord(record, { includeInstance: true }) : null;
    } catch (error) { this._reportError(error); return null; }
  }

  getInstance(name) {
    try { return this._features.get(normalizeText(name, 512))?.instance ?? null; }
    catch (error) { this._reportError(error); return null; }
  }

  list(options = {}) {
    try {
      if (this.isDestroyed) return Object.freeze([]);
      const settings = isRecord(options) ? options : {};
      let features = [...this._features.values()];
      if (typeof settings.enabled === "boolean") features = features.filter((feature) => feature.enabled === settings.enabled);
      const query = normalizeText(settings.query ?? settings.search, 1000).toLowerCase();
      if (query) features = features.filter((feature) => [feature.name, feature.version, JSON.stringify(feature.metadata)].some((value) => value.toLowerCase().includes(query)));
      const sort = normalizeText(settings.sortBy ?? settings.sort, 32).toLowerCase();
      if (sort === "registeredat") features.sort((a, b) => a.registeredAt - b.registeredAt || a.name.localeCompare(b.name));
      else if (sort === "updatedat") features.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
      else features.sort((a, b) => a.name.localeCompare(b.name));
      const offsetValue = Number(settings.offset ?? 0);
      const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0;
      const limit = normalizeLimit(settings.limit ?? features.length, features.length);
      return Object.freeze(features.slice(offset, offset + limit).map((feature) => this._publicRecord(feature, { includeInstance: settings.includeInstances === true })).filter(Boolean));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getFeatures(options = {}) { return this.list(options); }

  setEnabled(name, enabled, options = {}) {
    try {
      if (this.isDestroyed || typeof enabled !== "boolean") return false;
      const key = normalizeText(name, 512);
      const feature = this._features.get(key);
      if (!feature) return false;
      if (feature.enabled === enabled) return true;
      const updated = { ...feature, enabled, updatedAt: Date.now() };
      this._features.set(key, updated);
      const settings = isRecord(options) ? options : {};
      this._persist();
      if (settings.silent !== true) this._notify(enabled ? "enabled" : "disabled", updated);
      return true;
    } catch (error) { this._reportError(error, name); return false; }
  }

  enable(name, options) { return this.setEnabled(name, true, options); }
  disable(name, options) { return this.setEnabled(name, false, options); }
  isEnabled(name) {
    try { return this._features.get(normalizeText(name, 512))?.enabled === true; }
    catch { return false; }
  }

  update(name, changes = {}, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(changes)) return null;
      const key = normalizeText(name, 512);
      const previous = this._features.get(key);
      if (!previous || (changes.name !== undefined && normalizeText(changes.name, 512) !== key)) return null;
      const descriptor = { ...previous, ...changes, name: key, instance: changes.instance ?? previous.instance };
      const updated = this._normalizeRegistration(descriptor, options, previous);
      if (!updated) return null;
      this._features.set(key, updated);
      const settings = isRecord(options) ? options : {};
      this._persist();
      if (settings.silent !== true) this._notify("updated", updated);
      return this._publicRecord(updated, { includeInstance: true });
    } catch (error) { this._reportError(error, name); return null; }
  }

  unregister(name, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const key = normalizeText(name, 512);
      const feature = this._features.get(key);
      if (!feature) return false;
      this._features.delete(key);
      const settings = isRecord(options) ? options : {};
      if (settings.destroy === true) this._destroyModule(feature);
      this._persist();
      if (settings.silent !== true) this._notify("unregistered", feature);
      return true;
    } catch (error) { this._reportError(error, name); return false; }
  }

  unregisterFeature(name, options) { return this.unregister(name, options); }

  inspect(name) {
    try {
      const feature = this._features.get(normalizeText(name, 512));
      if (!feature) return null;
      const methods = getMethodNames(feature.instance);
      const capabilities = getCapabilities(feature.instance);
      return Object.freeze({ ...this._publicRecord(feature), capabilities, methods, status: this._moduleStatus(feature), healthy: this._moduleHealthy(feature) });
    } catch (error) { this._reportError(error, name); return null; }
  }

  inspectAll() {
    try { return Object.freeze([...this._features.keys()].sort().map((name) => this.inspect(name)).filter(Boolean)); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  _moduleStatus(feature) {
    try {
      if (!feature.enabled) return "disabled";
      if (feature.instance == null) return "missing-instance";
      if (feature.instance.isDestroyed === true) return "destroyed";
      const status = getSafeStatus(feature.instance);
      if (isRecord(status) && status.error) return "status-error";
      if (typeof status === "string" && ["error", "failed", "unhealthy", "destroyed"].includes(status.toLowerCase())) return status.toLowerCase();
      return "healthy";
    } catch { return "unknown"; }
  }

  _moduleHealthy(feature) {
    try { return this._moduleStatus(feature) === "healthy"; }
    catch { return false; }
  }

  getHealthReport() {
    try {
      const features = this.inspectAll();
      const byStatus = Object.create(null);
      for (const feature of features) byStatus[feature.status] = (byStatus[feature.status] ?? 0) + 1;
      return Object.freeze({ total: features.length, enabled: features.filter((feature) => feature.enabled).length, healthy: features.filter((feature) => feature.healthy).length, unhealthy: features.filter((feature) => !feature.healthy).length, byStatus: Object.freeze({ ...byStatus }), features });
    } catch (error) { this._reportError(error); return Object.freeze({ total: 0, enabled: 0, healthy: 0, unhealthy: 0, byStatus: Object.freeze({}), features: Object.freeze([]) }); }
  }

  health() { return this.getHealthReport(); }

  _destroyModule(feature) {
    try {
      if (!feature?.instance || typeof feature.instance.destroy !== "function") return Object.freeze({ name: feature?.name ?? "", destroyed: false, reason: "no-destroy-method" });
      try {
        const result = feature.instance.destroy();
        if (result && typeof result.then === "function") {
          return result.then(() => Object.freeze({ name: feature.name, destroyed: true })).catch((error) => {
            this._reportError(error, feature.name);
            return Object.freeze({ name: feature.name, destroyed: false, error: normalizeText(error?.message, 1000) });
          });
        }
        return Object.freeze({ name: feature.name, destroyed: result !== false });
      } catch (error) {
        this._reportError(error, feature.name);
        return Object.freeze({ name: feature.name, destroyed: false, error: normalizeText(error?.message, 1000) });
      }
    } catch (error) {
      this._reportError(error, feature?.name);
      return Object.freeze({ name: feature?.name ?? "", destroyed: false, error: normalizeText(error?.message, 1000) });
    }
  }

  destroyAll(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const results = [...this._features.values()].map((feature) => this._destroyModule(feature));
      if (settings.unregister === true) this._features.clear();
      if (settings.persist !== false) this._persist();
      if (settings.silent !== true) this._notify("destroy-all", null, { results: Object.freeze(results) });
      return results.some((result) => result && typeof result.then === "function")
        ? Promise.all(results).then((settled) => Object.freeze(settled))
        : Object.freeze(results);
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

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
        } catch { return false; }
      };
    } catch (error) { this._reportError(error); return () => false; }
  }

  unsubscribe(listener) {
    try { return this._listeners.delete(listener); }
    catch (error) { this._reportError(error); return false; }
  }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 1, exportedAt: Date.now(), features: this.list() };
      return settings.asObject === true ? freezeDeep(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      const records = Array.isArray(payload) ? payload : (isRecord(payload) ? payload.features : null);
      if (!Array.isArray(records)) return 0;
      let imported = 0;
      for (const candidate of records.slice(0, MAX_FEATURES)) {
        const record = normalizePersistedRecord(candidate);
        if (!record) continue;
        this._persisted.set(record.name, record);
        const current = this._features.get(record.name);
        if (current) {
          this._features.set(record.name, { ...current, version: record.version || current.version, enabled: record.enabled, metadata: record.metadata, updatedAt: record.updatedAt });
        }
        imported += 1;
      }
      if (settings.replace === true) {
        const names = new Set(records.map((item) => normalizeText(item?.name, 512)).filter(Boolean));
        for (const name of [...this._persisted.keys()]) if (!names.has(name)) this._persisted.delete(name);
      }
      this._persist();
      if (settings.silent !== true) this._notify("imported", null);
      return imported;
    } catch (error) { this._reportError(error); return 0; }
  }

  get size() { try { return this._features.size; } catch { return 0; } }
  get count() { return this.size; }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      const settings = isRecord(options) ? options : {};
      const results = [...this._features.values()].map((feature) => this._destroyModule(feature));
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      if (settings.clear === true) this._features.clear();
      return results.some((result) => result && typeof result.then === "function")
        ? Promise.all(results).then((settled) => Object.freeze(settled))
        : true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Safely create a registry hub in browser, server, or restricted-storage environments. */
export function createFeatureRegistryHub(options = {}) {
  try { return new FeatureRegistryHub(options); }
  catch { return null; }
}

export default Object.freeze({ FeatureRegistryHub, createFeatureRegistryHub });
