const HISTORY_STORAGE_KEY = "trick-a4if-tube:search-filter-history:v1";
const memoryStorage = new Map();
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;
const MAX_QUERY_LENGTH = 500;
const FIELD_WEIGHTS = Object.freeze({ title: 5, channel: 3, author: 3, category: 2, tags: 2, description: 1 });

function isRecord(value) {
  try {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

/** Normalize text for case- and diacritic-insensitive search matching. */
export function normalizeSearchText(value) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  } catch {
    try { return String(value ?? "").toLowerCase().trim(); } catch { return ""; }
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

function normalizeNonNegative(value, fallback = null) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
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
  } catch {
    return result;
  }
}

function getFields(item) {
  try {
    const source = isRecord(item) ? item : {};
    return {
      title: collectText(source.title ?? source.name).join(" "),
      channel: collectText(source.channel ?? source.channelName ?? source.uploader).join(" "),
      author: collectText(source.author ?? source.creator).join(" "),
      category: collectText(source.category ?? source.categories).join(" "),
      tags: collectText(source.tags ?? source.tag).join(" "),
      description: collectText(source.description ?? source.summary).join(" "),
    };
  } catch {
    return { title: "", channel: "", author: "", category: "", tags: "", description: "" };
  }
}

function safeFlag(item) {
  try {
    const source = isRecord(item) ? item : {};
    if (source.isSafe === true || source.safeContent === true || source.safe === true) return true;
    if (source.isSafe === false || source.safeContent === false || source.safe === false) return false;
    if (source.isAdult === true || source.explicit === true || source.isExplicit === true || source.nsfw === true) return false;
    const rating = normalizeText(source.contentRating ?? source.rating, 80).toLocaleLowerCase();
    if (["adult", "explicit", "mature", "nsfw", "18+"].includes(rating)) return false;
    return null;
  } catch {
    return null;
  }
}

function getTimestamp(item) {
  try {
    const source = isRecord(item) ? item : {};
    const value = Number(source.publishedAt ?? source.createdAt ?? source.uploadedAt ?? source.timestamp ?? source.date);
    if (Number.isFinite(value)) return value;
    const parsed = Date.parse(source.publishedAt ?? source.createdAt ?? source.uploadedAt ?? source.date ?? "");
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getDuration(item) {
  try {
    const source = isRecord(item) ? item : {};
    return normalizeNonNegative(source.durationSeconds ?? source.duration ?? source.lengthSeconds, null);
  } catch {
    return null;
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

function normalizeHistory(value, limit) {
  try {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
      const query = normalizeText(typeof entry === "string" ? entry : entry?.query, MAX_QUERY_LENGTH);
      const normalized = normalizeSearchText(query);
      if (!query || !normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const searchedAtValue = Number(isRecord(entry) ? entry.searchedAt : 0);
      result.push(Object.freeze({ query, normalized, searchedAt: Number.isFinite(searchedAtValue) ? searchedAtValue : 0 }));
      if (result.length >= limit) break;
    }
    return result;
  } catch {
    return [];
  }
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
  } catch {
    return 0;
  }
}

/** Calculate relevance score for one item; query terms are AND-matched by default. */
export function scoreSearchResult(item, query, options = {}) {
  try {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return 0;
    const terms = normalizedQuery.split(" ").filter(Boolean);
    const fields = getFields(item);
    if (options?.requireAllTerms !== false && !terms.every((term) => Object.values(fields).some((field) => field.includes(term)))) return 0;
    let score = 0;
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) score += fieldScore(fields[field], terms, weight);
    if (terms.length > 1) {
      const fullText = Object.values(fields).join(" ");
      if (fullText.includes(normalizedQuery)) score += 5;
      if (fields.title.includes(normalizedQuery)) score += 10;
    }
    return Number.isFinite(score) ? score : 0;
  } catch {
    return 0;
  }
}

/**
 * Search and filter caller-provided video records. This class does not fetch or
 * fabricate results; it only processes the array supplied to search().
 */
export class SearchFilterEngine {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    const historyLimitValue = Number(settings.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.historyLimit = Number.isFinite(historyLimitValue)
      ? Math.min(MAX_HISTORY_LIMIT, Math.max(0, Math.floor(historyLimitValue)))
      : DEFAULT_HISTORY_LIMIT;
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || HISTORY_STORAGE_KEY;
    this.onHistoryChange = typeof settings.onHistoryChange === "function" ? settings.onHistoryChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.queryHistory = [];
    this._loadHistory();
  }

  /** Search and filter an array of video-like records. */
  search(items, query = "", filters = {}) {
    try {
      if (!Array.isArray(items)) return Object.freeze([]);
      const settings = isRecord(filters) ? filters : {};
      const queryText = normalizeText(query, MAX_QUERY_LENGTH);
      const normalizedQuery = normalizeSearchText(queryText);
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
        const score = terms.length ? scoreSearchResult(item, queryText, { requireAllTerms }) : 0;
        candidates.push({ item, score, originalIndex: index, timestamp: getTimestamp(item), duration: getDuration(item) });
      }

      const sortMode = normalizeText(settings.sortBy ?? settings.sort ?? (terms.length ? "relevance" : "newest"), 40).toLocaleLowerCase();
      candidates.sort((left, right) => this._compareResults(left, right, sortMode, terms.length > 0));
      const offsetValue = Number(settings.offset ?? 0);
      const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
      const limitValue = Number(settings.limit);
      const end = Number.isInteger(limitValue) && limitValue >= 0 ? offset + limitValue : undefined;
      const results = candidates.slice(offset, end).map((entry) => {
        if (settings.includeScore === true) return Object.freeze({ ...entry.item, score: entry.score });
        return entry.item;
      });
      return Object.freeze(results);
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Alias for search(). */
  filter(items, filters = {}) {
    try {
      const settings = isRecord(filters) ? filters : {};
      const query = settings.query ?? "";
      return this.search(items, query, { ...settings, recordHistory: settings.recordHistory ?? false });
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Return the relevance score for an item and query. */
  score(item, query, options = {}) {
    try { return scoreSearchResult(item, query, options); } catch { return 0; }
  }

  /** Add a query to persistent, deduplicated recent-search history. */
  addQueryToHistory(query) {
    try {
      const text = normalizeText(query, MAX_QUERY_LENGTH);
      const normalized = normalizeSearchText(text);
      if (!text || !normalized || this.historyLimit === 0) return false;
      this.queryHistory = this.queryHistory.filter((entry) => entry.normalized !== normalized);
      this.queryHistory.unshift(Object.freeze({ query: text, normalized, searchedAt: Date.now() }));
      this.queryHistory = this.queryHistory.slice(0, this.historyLimit);
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Get recent search queries, newest first. */
  getQueryHistory(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const limit = Number(settings.limit);
      const entries = this.queryHistory.slice();
      if (settings.newestFirst === false) entries.reverse();
      const result = Number.isInteger(limit) && limit >= 0 ? entries.slice(0, limit) : entries;
      return Object.freeze(result.map((entry) => settings.includeMetadata === true
        ? entry
        : entry.query));
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  /** Remove one recent query or clear all query history. */
  removeQueryFromHistory(query) {
    try {
      const normalized = normalizeSearchText(query);
      const previousLength = this.queryHistory.length;
      this.queryHistory = this.queryHistory.filter((entry) => entry.normalized !== normalized);
      if (this.queryHistory.length === previousLength) return false;
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  clearQueryHistory() {
    try {
      if (!this.queryHistory.length) return true;
      this.queryHistory = [];
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Set the maximum number of retained query history entries. */
  setHistoryLimit(limit) {
    try {
      const value = Number(limit);
      if (!Number.isFinite(value) || value < 0) return false;
      this.historyLimit = Math.min(MAX_HISTORY_LIMIT, Math.floor(value));
      this.queryHistory = this.queryHistory.slice(0, this.historyLimit);
      this._persistHistory();
      this._notifyHistoryChange();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Apply category, recency, duration, and safe-content constraints. */
  _matchesFilters(item, fields, filters) {
    try {
      const categoryFilter = filters.category ?? filters.categories;
      if (categoryFilter !== undefined && categoryFilter !== null && categoryFilter !== "") {
        const accepted = (Array.isArray(categoryFilter) ? categoryFilter : [categoryFilter])
          .map((value) => normalizeSearchText(value)).filter(Boolean);
        const itemCategory = fields.category;
        if (!accepted.length || !accepted.some((category) => itemCategory === category || itemCategory.split(" ").includes(category))) return false;
      }

      const duration = getDuration(item);
      const minDuration = normalizeNonNegative(filters.minDurationSeconds ?? filters.minDuration, null);
      const maxDuration = normalizeNonNegative(filters.maxDurationSeconds ?? filters.maxDuration, null);
      if (minDuration !== null && (duration === null || duration < minDuration)) return false;
      if (maxDuration !== null && (duration === null || duration > maxDuration)) return false;

      const nowValue = Number(filters.now ?? Date.now());
      const now = Number.isFinite(nowValue) ? nowValue : Date.now();
      const recencyDays = normalizeNonNegative(filters.recencyDays ?? filters.withinDays, null);
      const since = normalizeNonNegative(filters.after ?? filters.since, null);
      const before = normalizeNonNegative(filters.before, null);
      const timestamp = getTimestamp(item);
      if ((recencyDays !== null || since !== null || before !== null) && timestamp === null) return false;
      if (recencyDays !== null && timestamp < now - recencyDays * 86400000) return false;
      if (since !== null && timestamp < since) return false;
      if (before !== null && timestamp > before) return false;

      const safeOnly = filters.safeContent === true || filters.safeOnly === true || filters.isSafe === true;
      const unsafeOnly = filters.safeContent === false || filters.safeOnly === false || filters.isSafe === false;
      const safe = safeFlag(item);
      if (safeOnly && safe !== true) return false;
      if (unsafeOnly && safe !== false) return false;
      return true;
    } catch {
      return false;
    }
  }

  _compareResults(left, right, sortMode, hasQuery) {
    try {
      let order = 0;
      switch (sortMode) {
        case "newest":
        case "recent":
          order = (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity);
          break;
        case "oldest":
          order = (left.timestamp ?? Infinity) - (right.timestamp ?? Infinity);
          break;
        case "longest":
          order = (right.duration ?? -Infinity) - (left.duration ?? -Infinity);
          break;
        case "shortest":
          order = (left.duration ?? Infinity) - (right.duration ?? Infinity);
          break;
        case "title":
          order = normalizeSearchText(left.item.title ?? left.item.name)
            .localeCompare(normalizeSearchText(right.item.title ?? right.item.name));
          break;
        case "relevance":
        default:
          order = hasQuery ? right.score - left.score : 0;
          if (order === 0) order = (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity);
          break;
      }
      return order || left.originalIndex - right.originalIndex;
    } catch {
      return left.originalIndex - right.originalIndex;
    }
  }

  _loadHistory() {
    try {
      let raw = null;
      if (this.storage) raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.queryHistory = normalizeHistory(Array.isArray(parsed) ? parsed : parsed?.queries, this.historyLimit);
    } catch (error) {
      this.queryHistory = [];
      this._reportError(error);
    }
  }

  _persistHistory() {
    try {
      const value = JSON.stringify({ version: 1, queries: this.queryHistory });
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

  _notifyHistoryChange() {
    try {
      if (this.onHistoryChange) this.onHistoryChange(this.getQueryHistory({ includeMetadata: true }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Search filter operation failed.");
      if (this.onError) {
        try { this.onError(this.lastError); } catch { /* Error callbacks must not escape. */ }
      }
    } catch {
      // Error reporting must never interrupt search or history operations.
    }
  }
}

/** Create a search engine without throwing when browser storage is unavailable. */
export function createSearchFilterEngine(options = {}) {
  try {
    return new SearchFilterEngine(options);
  } catch {
    return null;
  }
}

export const SEARCH_SORT_MODES = Object.freeze(["relevance", "newest", "oldest", "longest", "shortest", "title"]);

export default Object.freeze({
  SEARCH_SORT_MODES,
  SearchFilterEngine,
  createSearchFilterEngine,
  normalizeSearchText,
  scoreSearchResult,
});
