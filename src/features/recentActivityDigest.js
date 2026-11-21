const STORAGE_KEY = "trick-a4if-tube:recent-activity-digest:v1";
const memoryStorage = new Map();
const DEFAULT_MAX_ITEMS = 500;
const MAX_ITEMS = 10000;
const MAX_TEXT_LENGTH = 2000;
const MAX_METADATA_LENGTH = 100000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeLimit(value, fallback = DEFAULT_MAX_ITEMS) {
  try {
    if (value === Infinity) return MAX_ITEMS;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_ITEMS, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
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

function cloneMetadata(value) {
  try {
    if (value === undefined || value === null) return {};
    if (!isRecord(value) && !Array.isArray(value)) return {};
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || serialized.length > MAX_METADATA_LENGTH) return {};
    const cloned = JSON.parse(serialized);
    return cloned && typeof cloned === "object" ? cloned : {};
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

function normalizeActivity(input, now = Date.now(), previous = null) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeText(input.id ?? previous?.id, 512);
    const type = normalizeText(input.type ?? previous?.type, 128);
    if (!id || !type) return null;
    const timestamp = normalizeTimestamp(input.timestamp ?? input.createdAt, now);
    const metadata = input.metadata === undefined && previous
      ? cloneMetadata(previous.metadata)
      : cloneMetadata(input.metadata);
    return freezeDeep({
      id,
      type,
      title: normalizeText(input.title ?? previous?.title, 1000),
      targetId: normalizeText(input.targetId ?? previous?.targetId, 512),
      channel: normalizeText(input.channel ?? previous?.channel, 500),
      category: normalizeText(input.category ?? previous?.category, 300),
      timestamp,
      metadata,
    });
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function frozenList(items) {
  try { return Object.freeze(items.slice()); }
  catch { return Object.freeze([]); }
}

function normalizeStringSet(value) {
  try {
    const values = Array.isArray(value) ? value : [value];
    return new Set(values.map((item) => normalizeText(item).toLocaleLowerCase()).filter(Boolean));
  } catch { return new Set(); }
}

/**
 * Store a bounded, most-recent-first activity history and produce summaries.
 * Timestamps are Unix epoch milliseconds. Data is persisted locally when
 * storage is available and otherwise retained in a module-level memory store.
 */
export class RecentActivityDigest {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.maxItems = normalizeLimit(settings.maxItems ?? settings.limit ?? settings.retentionLimit);
    this.limit = this.maxItems;
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._activities = [];
    this._listeners = new Set();
    this._load();
    if (Array.isArray(settings.activities) && this._activities.length === 0) {
      this.importJSON(settings.activities, { replace: true, silent: true });
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Recent activity operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate error handlers. */ }
    } catch { /* Error reporting must never disrupt activity operations. */ }
  }

  _enforceLimit() {
    try {
      this._activities.sort((left, right) => right.timestamp - left.timestamp);
      if (this._activities.length > this.maxItems) this._activities.length = this.maxItems;
    } catch (error) { this._reportError(error); }
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
      const records = Array.isArray(payload) ? payload : payload?.activities;
      if (!Array.isArray(records)) return false;
      const byId = new Map();
      for (const candidate of records) {
        const activity = normalizeActivity(candidate);
        if (!activity) continue;
        const previous = byId.get(activity.id);
        if (!previous || activity.timestamp >= previous.timestamp) byId.set(activity.id, activity);
      }
      this._activities = [...byId.values()];
      this._enforceLimit();
      return true;
    } catch (error) {
      this._activities = [];
      this._reportError(error);
      return false;
    }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, activities: this._activities });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, activity = null) {
    try {
      const event = Object.freeze({ type, activity: activity ?? null, activities: this.getActivities() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  /** Add an activity or update the existing activity with the same id. */
  record(activity, details = {}) {
    try {
      if (this.isDestroyed || this.maxItems === 0) return null;
      const input = isRecord(activity)
        ? { ...activity, ...(isRecord(details) ? details : {}) }
        : { ...(isRecord(details) ? details : {}), id: activity };
      const id = normalizeText(input.id, 512);
      if (!id) return null;
      const previous = this._activities.find((item) => item.id === id) ?? null;
      const normalized = normalizeActivity(input, Date.now(), previous);
      if (!normalized) return null;
      this._activities = [normalized, ...this._activities.filter((item) => item.id !== id)];
      this._enforceLimit();
      this._persist();
      this._notify(previous ? "updated" : "recorded", normalized);
      return normalized;
    } catch (error) { this._reportError(error); return null; }
  }

  add(activity, details) { return this.record(activity, details); }
  recordActivity(activity, details) { return this.record(activity, details); }

  /** Update an existing activity; an unknown id is not implicitly inserted. */
  update(activity, details = {}) {
    try {
      if (this.isDestroyed) return null;
      const input = isRecord(activity)
        ? { ...activity, ...(isRecord(details) ? details : {}) }
        : { ...(isRecord(details) ? details : {}), id: activity };
      const id = normalizeText(input.id, 512);
      const previous = this._activities.find((item) => item.id === id) ?? null;
      if (!previous) return null;
      const normalized = normalizeActivity(input, Date.now(), previous);
      if (!normalized) return null;
      this._activities = [normalized, ...this._activities.filter((item) => item.id !== id)];
      this._enforceLimit();
      this._persist();
      this._notify("updated", normalized);
      return normalized;
    } catch (error) { this._reportError(error); return null; }
  }

  get(id) {
    try {
      const key = normalizeText(id, 512);
      return this._activities.find((activity) => activity.id === key) ?? null;
    } catch { return null; }
  }

  /** Query activities with exact filters, text search, sorting and pagination. */
  getActivities(options = {}) {
    try {
      const settings = typeof options === "string" ? { search: options } : (isRecord(options) ? options : {});
      let results = this._activities.slice();
      const types = normalizeStringSet(settings.types ?? settings.type);
      const categories = normalizeStringSet(settings.categories ?? settings.category);
      const channels = normalizeStringSet(settings.channels ?? settings.channel);
      if (types.size) results = results.filter((item) => types.has(item.type.toLocaleLowerCase()));
      if (categories.size) results = results.filter((item) => categories.has(item.category.toLocaleLowerCase()));
      if (channels.size) results = results.filter((item) => channels.has(item.channel.toLocaleLowerCase()));
      for (const field of ["id", "targetId"]) {
        if (settings[field] !== undefined && settings[field] !== null) {
          const expected = normalizeText(settings[field], 512);
          results = results.filter((item) => item[field] === expected);
        }
      }
      const query = normalizeText(settings.search ?? settings.query, 1000).toLocaleLowerCase();
      if (query) results = results.filter((item) => [item.id, item.type, item.title, item.targetId, item.channel, item.category]
        .some((value) => value.toLocaleLowerCase().includes(query)));
      const since = settings.since ?? settings.from;
      const before = settings.before ?? settings.to;
      if (since !== undefined && since !== null) {
        const lower = normalizeTimestamp(since, NaN);
        if (Number.isFinite(lower)) results = results.filter((item) => item.timestamp >= lower);
      }
      if (before !== undefined && before !== null) {
        const upper = normalizeTimestamp(before, NaN);
        if (Number.isFinite(upper)) results = results.filter((item) => item.timestamp <= upper);
      }
      const sortBy = normalizeText(settings.sortBy ?? settings.sort ?? "timestamp", 32);
      const allowedSortFields = new Set(["timestamp", "title", "type", "channel", "category", "id"]);
      const field = allowedSortFields.has(sortBy) ? sortBy : "timestamp";
      const direction = settings.order === "asc" || settings.ascending === true ? 1 : -1;
      results.sort((left, right) => typeof left[field] === "string"
        ? direction * left[field].localeCompare(right[field])
        : direction * (left[field] - right[field]));
      const offset = normalizeLimit(settings.offset ?? 0, 0);
      const limit = settings.limit === undefined ? results.length : normalizeLimit(settings.limit, 0);
      return frozenList(results.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  list(options = {}) { return this.getActivities(options); }
  search(query, options = {}) {
    try { return this.getActivities({ ...(isRecord(options) ? options : {}), search: query }); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }
  filter(options = {}) { return this.getActivities(options); }

  /** Group the filtered activities by type, channel, category, or another field. */
  groupBy(field = "type", options = {}) {
    try {
      const key = normalizeText(field, 64) || "type";
      const groups = Object.create(null);
      for (const activity of this.getActivities(options)) {
        const value = key === "metadata" ? "[metadata]" : normalizeText(activity[key], 512);
        const groupKey = value || "(none)";
        (groups[groupKey] ??= []).push(activity);
      }
      for (const groupKey of Object.keys(groups)) groups[groupKey] = frozenList(groups[groupKey]);
      return Object.freeze(groups);
    } catch (error) { this._reportError(error); return Object.freeze({}); }
  }

  groupActivities(field = "type", options = {}) { return this.groupBy(field, options); }

  /** Return counts by type and disjoint age windows relative to `now`. */
  getDigest(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const now = normalizeTimestamp(settings.now, Date.now());
      const activities = this.getActivities(settings);
      const countsByType = Object.create(null);
      const windows = { lastHour: 0, last24Hours: 0, last7Days: 0, older: 0 };
      for (const activity of activities) {
        countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
        const age = Math.max(0, now - activity.timestamp);
        if (age <= HOUR_MS) windows.lastHour += 1;
        else if (age <= DAY_MS) windows.last24Hours += 1;
        else if (age <= 7 * DAY_MS) windows.last7Days += 1;
        else windows.older += 1;
      }
      const mostRecent = activities.reduce((latest, item) => !latest || item.timestamp > latest.timestamp ? item : latest, null);
      const byType = Object.fromEntries(Object.entries(countsByType).sort(([left], [right]) => left.localeCompare(right)));
      return Object.freeze({
        total: activities.length,
        countsByType: Object.freeze(byType),
        timeWindows: Object.freeze(windows),
        mostRecent,
        generatedAt: now,
      });
    } catch (error) {
      this._reportError(error);
      return Object.freeze({ total: 0, countsByType: Object.freeze({}), timeWindows: Object.freeze({ lastHour: 0, last24Hours: 0, last7Days: 0, older: 0 }), mostRecent: null, generatedAt: Date.now() });
    }
  }

  summarize(options = {}) { return this.getDigest(options); }
  getSummary(options = {}) { return this.getDigest(options); }

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

  remove(id) {
    try {
      if (this.isDestroyed) return false;
      const key = normalizeText(id, 512);
      const index = this._activities.findIndex((item) => item.id === key);
      if (!key || index < 0) return false;
      const [removed] = this._activities.splice(index, 1);
      this._persist();
      this._notify("removed", removed);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clear() {
    try {
      if (this.isDestroyed) return false;
      if (this._activities.length === 0) return true;
      this._activities = [];
      this._persist();
      this._notify("cleared");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 1, exportedAt: Date.now(), activities: this.getActivities({ sortBy: "timestamp", order: "desc" }) };
      return settings.asObject === true ? freezeDeep(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { activities: payload };
      if (!isRecord(payload)) return 0;
      const records = payload.activities ?? payload.entries ?? payload.items;
      if (!Array.isArray(records)) return 0;
      const byId = new Map(settings.replace === true ? [] : this._activities.map((item) => [item.id, item]));
      let importedCount = 0;
      for (const candidate of records) {
        const activity = normalizeActivity(candidate);
        if (!activity) continue;
        const previous = byId.get(activity.id);
        if (!previous || activity.timestamp >= previous.timestamp) byId.set(activity.id, activity);
        importedCount += 1;
      }
      this._activities = [...byId.values()];
      this._enforceLimit();
      this._persist();
      if (!settings.silent && (importedCount > 0 || settings.replace === true)) this._notify("imported");
      return importedCount;
    } catch (error) { this._reportError(error); return 0; }
  }

  get size() { try { return this._activities.length; } catch { return 0; } }
  get count() { return this.size; }
  getActivitiesCount() { return this.size; }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a recent activity digest without throwing during setup. */
export function createRecentActivityDigest(options = {}) {
  try { return new RecentActivityDigest(options); }
  catch { return null; }
}

export default Object.freeze({ RecentActivityDigest, createRecentActivityDigest });
