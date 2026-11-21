const HISTORY_STORAGE_KEY = "trick-a4if-tube:search-filter-history:v1";
const memoryStorage = new Map();
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;
const MAX_QUERY_LENGTH = 500;
const DAY_MS = 86400000;
const FIELD_WEIGHTS = Object.freeze({ title: 5, channel: 3, creator: 3, category: 2, tags: 2, description: 1 });
export const SEARCH_SORT_MODES = Object.freeze(["relevance", "newest", "oldest", "views", "duration", "title"]);

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

/** Normalize text for case- and diacritic-insensitive token matching. */
export function normalizeSearchText(value) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  } catch {
    try { return String(value ?? "").toLowerCase().trim(); } catch { return ""; }
  }
}

function normalizeText(value, maxLength = 2000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeNonNegative(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function collectText(value, result = []) {
  try {
    if (Array.isArray(value)) {
      for (const item of value) collectText(item, result);
    } else if (typeof value === "string" || typeof value === "number") {
      const normalized = normalizeSearchText(value);
      if (normalized) result.push(normalized);
    }
    return result;
  } catch { return result; }
}

function getFields(item) {
  try {
    const source = isRecord(item) ? item : {};
    return {
      title: collectText(source.title ?? source.name).join(" "),
      channel: collectText(source.channel ?? source.channelName ?? source.uploader).join(" "),
      creator: collectText(source.creator ?? source.author).join(" "),
      category: collectText(source.category ?? source.categories).join(" "),
      tags: collectText(source.tags ?? source.tag).join(" "),
      description: collectText(source.description ?? source.summary).join(" "),
    };
  } catch {
    return { title: "", channel: "", creator: "", category: "", tags: "", description: "" };
  }
}

function getTimestamp(item) {
  try {
    const source = isRecord(item) ? item : {};
    const raw = source.publishedAt ?? source.createdAt ?? source.uploadedAt ?? source.timestamp ?? source.date;
    if (raw === null || raw === undefined || raw === "") return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

function getDuration(item) {
  try {
    const source = isRecord(item) ? item : {};
    return normalizeNonNegative(source.durationSeconds ?? source.duration ?? source.lengthSeconds, null);
  } catch { return null; }
}

function getViews(item) {
  try {
    const source = isRecord(item) ? item : {};
    return normalizeNonNegative(source.views ?? source.viewCount ?? source.viewsCount, null);
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeHistory(value, limit) {
  try {
    if (!Array.isArray(value) || limit <= 0) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
      const query = normalizeText(typeof entry === "string" ? entry : entry?.query, MAX_QUERY_LENGTH);
      const normalized = normalizeSearchText(query);
      if (!query || !normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const time = Number(isRecord(entry) ? entry.searchedAt : 0);
      result.push(Object.freeze({ query, normalized, searchedAt: Number.isFinite(time) && time >= 0 ? time : 0 }));
      if (result.length >= limit) break;
    }
    return result;
  } catch { return []; }
}

function fieldScore(value, terms, weight) {
  try {
    if (!value) return 0;
    let score = 0;
    for (const term of terms) {
      if (value === term) score += weight * 3;
      else if (value.startsWith(term)) score += weight * 2;
      else if (value.includes(term)) score += weight;
    }
    return score;
  } catch { return 0; }
}

/** Return a weighted relevance score; by default every query token must occur. */
export function scoreSearchResult(item, query, options = {}) {
  try {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return 0;
    const terms = normalizedQuery.split(" ").filter(Boolean);
    const fields = getFields(item);
    if (options?.requireAllTerms !== false && !terms.every((term) => Object.values(fields).some((field) => field.includes(term)))) return 0;
    let score = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) score += fieldScore(fields[field], terms, weight);
    const allText = Object.values(fields).join(" ");
    if (terms.length > 1 && allText.includes(normalizedQuery)) score += 5;
    if (terms.length > 1 && fields.title.includes(normalizedQuery)) score += 10;
    return Number.isFinite(score) ? score : 0;
  } catch { return 0; }
}

function normalizeFilterValues(value) {
  try {
    const values = (Array.isArray(value) ? value : [value]).map(normalizeSearchText).filter(Boolean);
    return [...new Set(values)];
  } catch { return []; }
}

function containsValue(fieldValue, accepted) {
  try {
    if (!accepted.length) return false;
    const words = fieldValue.split(" ");
    return accepted.some((value) => fieldValue === value || words.includes(value) || fieldValue.includes(value));
  } catch { return false; }
}

/**
 * Search and filter caller-supplied records only. Search history is persisted
 * locally; the engine does not fetch, invent, or simulate search results.
 */
export class SearchFilterEngine {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const rawLimit = Number(settings.historyLimit ?? DEFAULT_HISTORY_LIMIT);
      this.historyLimit = Number.isFinite(rawLimit) ? Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.floor(rawLimit))) : DEFAULT_HISTORY_LIMIT;
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || HISTORY_STORAGE_KEY;
      this.onHistoryChange = typeof settings.onHistoryChange === "function" ? settings.onHistoryChange : null;
      this.onQueryChange = typeof settings.onQueryChange === "function" ? settings.onQueryChange : null;
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.queryHistory = [];
      this.currentQuery = "";
      this.isDestroyed = false;
      this._subscribers = new Set();
      this._loadHistory();
    } catch {
      this.historyLimit = DEFAULT_HISTORY_LIMIT;
      this.storage = null;
      this.storageKey = HISTORY_STORAGE_KEY;
      this.onHistoryChange = null;
      this.onQueryChange = null;
      this.onChange = null;
      this.onError = null;
      this.lastError = null;
      this.queryHistory = [];
      this.currentQuery = "";
      this.isDestroyed = false;
      this._subscribers = new Set();
    }
  }

  /** Search and filter an array of video-like records. */
  search(items, query = "", filters = {}) {
    try {
      if (this.isDestroyed || !Array.isArray(items)) return Object.freeze([]);
      const settings = isRecord(filters) ? filters : {};
      const queryText = normalizeText(query, MAX_QUERY_LENGTH);
      const normalizedQuery = normalizeSearchText(queryText);
      this.setQuery(queryText);
      if (queryText && settings.recordHistory !== false) this.addQueryToHistory(queryText);
      const terms = normalizedQuery ? normalizedQuery.split(" ").filter(Boolean) : [];
      const requireAllTerms = settings.requireAllTerms !== false;
      const candidates = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!isRecord(item)) continue;
        const fields = getFields(item);
        const matchingTerms = terms.filter((term) => Object.values(fields).some((field) => field.includes(term)));
        if (terms.length && (requireAllTerms ? matchingTerms.length !== terms.length : matchingTerms.length === 0)) continue;
        if (!this._matchesFilters(item, fields, settings)) continue;
        candidates.push({ item, score: terms.length ? scoreSearchResult(item, queryText, { requireAllTerms }) : 0,
          originalIndex: index, timestamp: getTimestamp(item), duration: getDuration(item), views: getViews(item) });
      }
      const sortMode = normalizeText(settings.sortBy ?? settings.sort ?? (terms.length ? "relevance" : "newest"), 40).toLocaleLowerCase();
      candidates.sort((left, right) => this._compareResults(left, right, sortMode, terms.length > 0));
      const offsetValue = Number(settings.offset ?? 0);
      const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
      const limitValue = settings.limit === undefined ? null : Number(settings.limit);
      const end = Number.isInteger(limitValue) && limitValue >= 0 ? offset + limitValue : undefined;
      const results = candidates.slice(offset, end).map(({ item, score }) => settings.includeScore === true
        ? Object.freeze({ ...item, score }) : item);
      return Object.freeze(results);
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  filter(items, filters = {}) {
    try {
      const settings = isRecord(filters) ? filters : {};
      return this.search(items, settings.query ?? this.currentQuery, { ...settings, recordHistory: settings.recordHistory ?? false });
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  score(item, query, options = {}) {
    try { return scoreSearchResult(item, query, options); } catch { return 0; }
  }

  /** Update current query state and notify listeners only when it changes. */
  setQuery(query) {
    try {
      if (this.isDestroyed) return false;
      const next = normalizeText(query, MAX_QUERY_LENGTH);
      if (next === this.currentQuery) return false;
      this.currentQuery = next;
      this._notify({ type: "query", query: next, history: this.getQueryHistory({ includeMetadata: true }) });
      try { this.onQueryChange?.(next, this); } catch (error) { this._reportError(error); }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getQuery() { try { return this.currentQuery; } catch { return ""; } }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* Safe unsubscribe. */ } };
    } catch { return () => {}; }
  }

  subscribeToQuery(listener) { return this.subscribe(listener); }
  subscribeToHistory(listener) { return this.subscribe(listener); }

  addQueryToHistory(query) {
    try {
      if (this.isDestroyed) return false;
      const text = normalizeText(query, MAX_QUERY_LENGTH);
      const normalized = normalizeSearchText(text);
      if (!text || !normalized || this.historyLimit === 0) return false;
      this.queryHistory = this.queryHistory.filter((entry) => entry.normalized !== normalized);
      this.queryHistory.unshift(Object.freeze({ query: text, normalized, searchedAt: Date.now() }));
      this.queryHistory = this.queryHistory.slice(0, this.historyLimit);
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getQueryHistory(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const entries = this.queryHistory.slice();
      if (settings.newestFirst === false) entries.reverse();
      const limit = settings.limit === undefined ? null : Number(settings.limit);
      const selected = Number.isInteger(limit) && limit >= 0 ? entries.slice(0, limit) : entries;
      return Object.freeze(selected.map((entry) => settings.includeMetadata === true ? entry : entry.query));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  removeQueryFromHistory(query) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeSearchText(query);
      if (!normalized) return false;
      const previousLength = this.queryHistory.length;
      this.queryHistory = this.queryHistory.filter((entry) => entry.normalized !== normalized);
      if (this.queryHistory.length === previousLength) return false;
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clearQueryHistory() {
    try {
      if (this.isDestroyed) return false;
      if (!this.queryHistory.length) return true;
      this.queryHistory = [];
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  setHistoryLimit(limit) {
    try {
      const value = Number(limit);
      if (this.isDestroyed || !Number.isFinite(value) || value < 0) return false;
      this.historyLimit = Math.min(MAX_HISTORY_LIMIT, Math.floor(value));
      this.queryHistory = this.queryHistory.slice(0, this.historyLimit);
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _matchesFilters(item, fields, filters) {
    try {
      const category = filters.category ?? filters.categories;
      if (category !== undefined && category !== null && category !== "") {
        const accepted = normalizeFilterValues(category);
        if (!containsValue(fields.category, accepted)) return false;
      }
      const tag = filters.tag ?? filters.tags;
      if (tag !== undefined && tag !== null && tag !== "") {
        const accepted = normalizeFilterValues(tag);
        if (!containsValue(fields.tags, accepted)) return false;
      }
      const channelFilter = filters.channel ?? filters.channels;
      const creatorFilter = filters.creator ?? filters.author ?? filters.creators;
      if (channelFilter !== undefined && channelFilter !== null && channelFilter !== "") {
        if (!containsValue(fields.channel, normalizeFilterValues(channelFilter))) return false;
      }
      if (creatorFilter !== undefined && creatorFilter !== null && creatorFilter !== "") {
        if (!containsValue(fields.creator, normalizeFilterValues(creatorFilter))) return false;
      }
      const duration = getDuration(item);
      const minDuration = normalizeNonNegative(filters.minDurationSeconds ?? filters.minDuration, null);
      const maxDuration = normalizeNonNegative(filters.maxDurationSeconds ?? filters.maxDuration, null);
      if (minDuration !== null && (duration === null || duration < minDuration)) return false;
      if (maxDuration !== null && (duration === null || duration > maxDuration)) return false;

      const nowValue = Number(filters.now ?? Date.now());
      const now = Number.isFinite(nowValue) ? nowValue : Date.now();
      const recencyDays = normalizeNonNegative(filters.recencyDays ?? filters.withinDays, null);
      const since = normalizeDateBound(filters.after ?? filters.since);
      const before = normalizeDateBound(filters.before);
      const timestamp = getTimestamp(item);
      if ((recencyDays !== null || since !== null || before !== null) && timestamp === null) return false;
      if (recencyDays !== null && timestamp < now - recencyDays * DAY_MS) return false;
      if (since !== null && timestamp < since) return false;
      if (before !== null && timestamp > before) return false;
      const predicate = filters.predicate ?? filters.customPredicate ?? filters.filterFn;
      if (typeof predicate === "function" && !predicate(item)) return false;
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _compareResults(left, right, sortMode, hasQuery) {
    try {
      let order;
      switch (sortMode) {
        case "newest": case "recent":
          order = (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity); break;
        case "oldest":
          order = (left.timestamp ?? Infinity) - (right.timestamp ?? Infinity); break;
        case "views": case "viewcount":
          order = (right.views ?? -Infinity) - (left.views ?? -Infinity); break;
        case "duration": case "longest":
          order = (right.duration ?? -Infinity) - (left.duration ?? -Infinity); break;
        case "title":
          order = normalizeSearchText(left.item.title ?? left.item.name)
            .localeCompare(normalizeSearchText(right.item.title ?? right.item.name)); break;
        case "relevance": default:
          order = hasQuery ? right.score - left.score : 0;
          if (order === 0) order = (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity);
      }
      return order || left.originalIndex - right.originalIndex;
    } catch { return left.originalIndex - right.originalIndex; }
  }

  _loadHistory() {
    try {
      let raw = null;
      if (this.storage) {
        try { raw = this.storage.getItem(this.storageKey); }
        catch (error) { this._reportError(error); }
      }
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.queryHistory = normalizeHistory(Array.isArray(parsed) ? parsed : parsed?.queries, this.historyLimit);
    } catch (error) { this.queryHistory = []; this._reportError(error); }
  }

  _persistHistory() {
    try {
      const value = JSON.stringify({ version: 1, queries: this.queryHistory });
      memoryStorage.set(this.storageKey, value);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, value); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notifyHistoryChange() {
    try {
      const history = this.getQueryHistory({ includeMetadata: true });
      try { this.onHistoryChange?.(history, this); } catch (error) { this._reportError(error); }
      this._notify({ type: "history", query: this.currentQuery, history });
    } catch (error) { this._reportError(error); }
  }

  _notify(event) {
    try {
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      if (event.type === "query") {
        try { this.onQueryChange?.(event.query, this); } catch (error) { this._reportError(error); }
      }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Search filter operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate error handlers. */ }
    } catch { /* Error handling must not interrupt search operations. */ }
  }

  destroy() {
    try { this.isDestroyed = true; this._subscribers.clear(); return true; }
    catch { return false; }
  }
}

function normalizeDateBound(value) {
  try {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

/** Create a search/filter engine without throwing if setup or storage fails. */
export function createSearchFilterEngine(options = {}) {
  try { return new SearchFilterEngine(options); }
  catch { return null; }
}

export default Object.freeze({
  SEARCH_SORT_MODES,
  SearchFilterEngine,
  createSearchFilterEngine,
  normalizeSearchText,
  scoreSearchResult,
});
