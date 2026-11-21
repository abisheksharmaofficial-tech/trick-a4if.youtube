const STORAGE_KEY = "trick-a4if-tube:watch-history:v2";
const memoryStorage = new Map();
const DEFAULT_MAX_ITEMS = 500;
const MAX_ITEMS = 10000;
const MAX_ID_LENGTH = 512;

function isRecord(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function normalizeText(value, maxLength = 2000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch {
    return "";
  }
}

function normalizeNumber(value, fallback = 0) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeLimit(value, fallback = DEFAULT_MAX_ITEMS) {
  try {
    if (value === Infinity) return MAX_ITEMS;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_ITEMS, Math.max(0, Math.floor(number))) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.id ?? value.videoId ?? value.key, MAX_ID_LENGTH);
    return normalizeText(value, MAX_ID_LENGTH);
  } catch {
    return "";
  }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeEntry(input, now = Date.now(), previous = null) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeId(input.id ?? input.videoId ?? input.key) || previous?.id || "";
    if (!id) return null;

    const duration = normalizeNumber(input.duration ?? input.durationSeconds, previous?.duration ?? 0);
    const positionValue = input.position ?? input.currentTime ?? input.currentTimeSeconds;
    const rawPosition = normalizeNumber(positionValue, previous?.position ?? 0);
    const position = duration > 0 ? Math.min(rawPosition, duration) : rawPosition;
    const suppliedPercent = input.progressPercent ?? input.progress ?? previous?.progressPercent;
    let progressPercent = normalizeNumber(suppliedPercent, duration > 0 ? (position / duration) * 100 : 0);
    if (progressPercent <= 1 && suppliedPercent !== undefined && suppliedPercent !== null && suppliedPercent !== "") {
      progressPercent *= 100;
    }
    progressPercent = Math.min(100, Math.max(0, progressPercent));
    const completed = typeof input.completed === "boolean"
      ? input.completed
      : (previous && input.completed === undefined ? previous.completed : (duration > 0 && position >= duration));
    const lastWatchedAt = normalizeTimestamp(
      input.lastWatchedAt ?? input.watchedAt ?? input.updatedAt,
      now,
    );
    const watchCountValue = input.watchCount === undefined
      ? (previous ? previous.watchCount : 0)
      : normalizeNumber(input.watchCount, previous?.watchCount ?? 0);

    return Object.freeze({
      id,
      title: normalizeText(input.title ?? previous?.title, 1000),
      channel: normalizeText(input.channel ?? input.channelName ?? input.author ?? previous?.channel, 500),
      category: normalizeText(input.category ?? previous?.category, 300),
      thumbnail: normalizeText(input.thumbnail ?? input.thumbnailUrl ?? previous?.thumbnail, 4096),
      duration,
      position,
      progressPercent,
      completed: Boolean(completed),
      watchCount: Math.floor(watchCountValue),
      lastWatchedAt,
    });
  } catch {
    return null;
  }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") {
      return candidate;
    }
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function freezeList(entries) {
  try {
    return Object.freeze(entries.slice());
  } catch {
    return Object.freeze([]);
  }
}

function normalizeSortField(value) {
  try {
    const field = normalizeText(value, 32).toLowerCase();
    const aliases = { recent: "lastWatchedAt", date: "lastWatchedAt", title: "title", channel: "channel", category: "category", duration: "duration", position: "position", progress: "progressPercent", progresspercent: "progressPercent", watchcount: "watchCount" };
    return aliases[field] ?? (Object.hasOwn(aliases, field) ? aliases[field] : "lastWatchedAt");
  } catch {
    return "lastWatchedAt";
  }
}

/**
 * Maintain a bounded, most-recently-watched-first video history. Durations
 * and positions are seconds; progressPercent is 0–100 and timestamps are
 * Unix epoch milliseconds. Data stays local and falls back to memory when
 * browser storage is missing or unavailable.
 */
export class WatchHistoryManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.maxItems = normalizeLimit(settings.maxItems ?? settings.limit ?? settings.historyLimit);
      this.limit = this.maxItems;
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._entries = [];
      this._subscribers = new Set();
      this._load();
      if (Array.isArray(settings.entries) && this._entries.length === 0) {
        this.importJSON(settings.entries, { replace: true, silent: true });
      }
    } catch {
      this.maxItems = DEFAULT_MAX_ITEMS;
      this.limit = this.maxItems;
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.onChange = null;
      this.onError = null;
      this.lastError = null;
      this.isDestroyed = false;
      this._entries = [];
      this._subscribers = new Set();
    }
  }

  /** Record a viewing event, incrementing watchCount and promoting the item. */
  record(video, details = {}) {
    try {
      if (this.isDestroyed || this.maxItems === 0) return null;
      const input = isRecord(video)
        ? { ...video, ...(isRecord(details) ? details : {}) }
        : { ...(isRecord(details) ? details : {}), id: video };
      const id = normalizeId(input.id ?? input.videoId ?? input.key);
      if (!id) return null;
      const previous = this._entries.find((entry) => entry.id === id) ?? null;
      const now = Date.now();
      const updatedInput = { ...input, id, watchCount: input.watchCount ?? ((previous?.watchCount ?? 0) + 1), lastWatchedAt: input.lastWatchedAt ?? now };
      const entry = normalizeEntry(updatedInput, now, previous);
      if (!entry) return null;
      this._entries = [entry, ...this._entries.filter((item) => item.id !== id)];
      this._enforceLimit();
      this._persist();
      this._notifyChange(previous ? "updated" : "recorded", entry);
      return entry;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Update an existing record without incrementing its watch count. */
  update(video, details = {}) {
    try {
      if (this.isDestroyed) return null;
      const input = isRecord(video)
        ? { ...video, ...(isRecord(details) ? details : {}) }
        : { ...(isRecord(details) ? details : {}), id: video };
      const id = normalizeId(input.id ?? input.videoId ?? input.key);
      if (!id) return null;
      const previous = this._entries.find((entry) => entry.id === id) ?? null;
      if (!previous) return this.record(input, { watchCount: 0 });
      const entry = normalizeEntry({ ...input, id, watchCount: input.watchCount ?? previous.watchCount }, Date.now(), previous);
      if (!entry) return null;
      this._entries = [entry, ...this._entries.filter((item) => item.id !== id)];
      this._enforceLimit();
      this._persist();
      this._notifyChange("updated", entry);
      return entry;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  recordWatch(video, details = {}) { return this.record(video, details); }

  /** Return a frozen result list with optional filtering, search, sorting and pagination. */
  getHistory(options = {}) {
    try {
      const settings = typeof options === "string" ? { search: options } : (isRecord(options) ? options : {});
      let results = this._entries.slice();
      const category = normalizeText(settings.category, 300).toLocaleLowerCase();
      const channel = normalizeText(settings.channel, 500).toLocaleLowerCase();
      if (category) results = results.filter((entry) => entry.category.toLocaleLowerCase() === category);
      if (channel) results = results.filter((entry) => entry.channel.toLocaleLowerCase() === channel);
      if (typeof settings.completed === "boolean") results = results.filter((entry) => entry.completed === settings.completed);
      const query = normalizeText(settings.search ?? settings.query, 1000).toLocaleLowerCase();
      if (query) results = results.filter((entry) => [entry.id, entry.title, entry.channel, entry.category]
        .some((value) => value.toLocaleLowerCase().includes(query)));
      if (settings.id !== undefined || settings.videoId !== undefined) {
        const id = normalizeId(settings.id ?? settings.videoId);
        results = results.filter((entry) => entry.id === id);
      }
      const since = normalizeNumber(settings.since ?? settings.from, null);
      const before = normalizeNumber(settings.before ?? settings.to, null);
      if (since !== null) results = results.filter((entry) => entry.lastWatchedAt >= since);
      if (before !== null) results = results.filter((entry) => entry.lastWatchedAt <= before);

      const sortField = normalizeSortField(settings.sortBy ?? settings.sort ?? "recent");
      const direction = settings.order === "asc" || settings.ascending === true ? 1 : -1;
      results.sort((left, right) => {
        const a = left[sortField];
        const b = right[sortField];
        if (typeof a === "string") return direction * a.localeCompare(b);
        return direction * (a - b);
      });
      const offset = Math.floor(normalizeLimit(settings.offset ?? 0, 0));
      const limit = settings.limit === undefined ? results.length : normalizeLimit(settings.limit, 0);
      return freezeList(results.slice(offset, offset + limit));
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  list(options = {}) { return this.getHistory(options); }
  search(query, options = {}) { return this.getHistory({ ...((isRecord(options)) ? options : {}), search: query }); }
  get(id) {
    try { const normalized = normalizeId(id); return this._entries.find((entry) => entry.id === normalized) ?? null; }
    catch { return null; }
  }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* No-op unsubscribe. */ } };
    } catch {
      return () => {};
    }
  }

  remove(id) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeId(id);
      const index = this._entries.findIndex((entry) => entry.id === normalized);
      if (!normalized || index < 0) return false;
      const [removed] = this._entries.splice(index, 1);
      this._persist();
      this._notifyChange("removed", removed);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeEntry(id) { return this.remove(id); }

  clear() {
    try {
      if (this.isDestroyed) return false;
      if (this._entries.length === 0) return true;
      this._entries = [];
      this._persist();
      this._notifyChange("cleared", null);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clearHistory() { return this.clear(); }

  exportJSON(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const payload = { version: 2, exportedAt: Date.now(), entries: this.getHistory({ sortBy: settings.sortBy ?? "recent", order: settings.order }) };
      return settings.asObject === true ? Object.freeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { entries: payload };
      if (!isRecord(payload)) return 0;
      const records = payload.entries ?? payload.history ?? payload.items;
      if (!Array.isArray(records)) return 0;
      const byId = new Map(settings.replace === true ? [] : this._entries.map((entry) => [entry.id, entry]));
      let importedCount = 0;
      const now = Date.now();
      for (const candidate of records) {
        const id = normalizeId(candidate?.id ?? candidate?.videoId ?? candidate?.key);
        const entry = normalizeEntry(candidate, now, byId.get(id) ?? null);
        if (!entry) continue;
        const previous = byId.get(entry.id);
        if (!previous || entry.lastWatchedAt >= previous.lastWatchedAt) byId.set(entry.id, entry);
        importedCount += 1;
      }
      this._entries = [...byId.values()].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
      this._enforceLimit();
      this._persist();
      if (!settings.silent && (importedCount > 0 || settings.replace === true)) this._notifyChange("imported", null);
      return importedCount;
    } catch (error) { this._reportError(error); return 0; }
  }

  get size() { try { return this._entries.length; } catch { return 0; } }
  getHistoryCount() { return this.size; }

  destroy() {
    try { this._subscribers.clear(); this.isDestroyed = true; return true; }
    catch { return false; }
  }

  _enforceLimit() {
    try { if (this._entries.length > this.maxItems) this._entries.length = this.maxItems; }
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
      const records = Array.isArray(payload) ? payload : payload?.entries;
      if (!Array.isArray(records)) return;
      const byId = new Map();
      for (const candidate of records) {
        const entry = normalizeEntry(candidate);
        if (!entry) continue;
        const previous = byId.get(entry.id);
        if (!previous || entry.lastWatchedAt >= previous.lastWatchedAt) byId.set(entry.id, entry);
      }
      this._entries = [...byId.values()].sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
      this._enforceLimit();
    } catch (error) {
      this._entries = [];
      this._reportError(error);
    }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 2, entries: this._entries });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notifyChange(type, entry) {
    try {
      const event = Object.freeze({ type, entry: entry ?? null, history: this.getHistory() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Watch history operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Error callbacks must not escape. */ }
    } catch { /* Error reporting must never disrupt history operations. */ }
  }
}

/** Create a watch history manager without throwing if setup fails. */
export function createWatchHistoryManager(options = {}) {
  try { return new WatchHistoryManager(options); }
  catch { return null; }
}

export default Object.freeze({ WatchHistoryManager, createWatchHistoryManager });
