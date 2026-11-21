const STORAGE_KEY = "trick-a4if-tube:trending-discovery-ranker:v1";
const memoryStorage = new Map();
const MAX_TEXT_LENGTH = 2000;
const MAX_RULES = 1000;
const MAX_ITEMS = 100000;
const DEFAULT_WEIGHTS = Object.freeze({ views: 1, recency: 1, engagementRate: 1, boost: 1, pin: 1000000 });
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

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

function finiteNumber(value, fallback = 0) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch { return fallback; }
}

function nonNegative(value, fallback = 0) {
  const number = finiteNumber(value, fallback);
  return number >= 0 ? number : fallback;
}

function normalizeTimestamp(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number > 0 && number < 100000000000 ? number * 1000 : number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
}

function normalizeWeights(input, base = DEFAULT_WEIGHTS) {
  try {
    const values = isRecord(input) ? input : {};
    const result = {};
    for (const [key, fallback] of Object.entries(base)) {
      const candidate = values[key];
      const number = Number(candidate);
      result[key] = candidate === null || candidate === undefined || !Number.isFinite(number) ? fallback : number;
    }
    return Object.freeze(result);
  } catch { return DEFAULT_WEIGHTS; }
}

function normalizeRuleList(value) {
  try {
    if (!Array.isArray(value)) return Object.freeze([]);
    return Object.freeze(value.slice(0, MAX_RULES).filter(isRecord).map((rule) => Object.freeze({
      id: normalizeText(rule.id, 512),
      category: normalizeText(rule.category, 512).toLocaleLowerCase(),
      channel: normalizeText(rule.channelId ?? rule.channel, 512).toLocaleLowerCase(),
      minViews: rule.minViews == null ? null : nonNegative(rule.minViews, 0),
      boost: finiteNumber(rule.boost ?? rule.value, 0),
      pinned: rule.pinned === true || rule.pin === true,
    })));
  } catch { return Object.freeze([]); }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.videoId ?? value.id ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeSet(value) {
  try {
    const items = Array.isArray(value) ? value : value == null ? [] : [value];
    return Object.freeze([...new Set(items.map((item) => normalizeText(item, 512)).filter(Boolean))]);
  } catch { return Object.freeze([]); }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function clamp(value, minimum, maximum) {
  try { return Math.min(maximum, Math.max(minimum, value)); }
  catch { return minimum; }
}

function normalizeConfig(input = {}, base = {}) {
  try {
    const settings = isRecord(input) ? input : {};
    const prior = isRecord(base) ? base : {};
    const halfLife = nonNegative(settings.halfLifeMs ?? settings.recencyHalfLifeMs ?? prior.halfLifeMs, DEFAULT_HALF_LIFE_MS);
    return Object.freeze({
      weights: normalizeWeights(settings.weights, prior.weights ?? DEFAULT_WEIGHTS),
      halfLifeMs: halfLife,
      viewsScale: Math.max(1, nonNegative(settings.viewsScale ?? prior.viewsScale, 1000)),
      boostRules: normalizeRuleList(settings.boostRules ?? prior.boostRules),
      pinRules: normalizeRuleList(settings.pinRules ?? prior.pinRules),
      pinnedIds: normalizeSet(settings.pinnedIds ?? prior.pinnedIds),
      boostedIds: normalizeSet(settings.boostedIds ?? prior.boostedIds),
      categoryBoosts: normalizeCategoryBoosts(settings.categoryBoosts ?? prior.categoryBoosts),
      category: normalizeText(settings.category ?? prior.category, 512),
      timeWindowMs: settings.timeWindowMs === null ? null : nonNegative(settings.timeWindowMs ?? prior.timeWindowMs, 0),
      minScore: finiteNumber(settings.minScore ?? prior.minScore, -Infinity),
      maxResults: normalizeLimit(settings.maxResults ?? prior.maxResults, MAX_ITEMS),
    });
  } catch { return Object.freeze({ weights: DEFAULT_WEIGHTS, halfLifeMs: DEFAULT_HALF_LIFE_MS, viewsScale: 1000, boostRules: Object.freeze([]), pinRules: Object.freeze([]), pinnedIds: Object.freeze([]), boostedIds: Object.freeze([]), categoryBoosts: Object.freeze({}), category: "", timeWindowMs: null, minScore: -Infinity, maxResults: MAX_ITEMS }); }
}

function normalizeCategoryBoosts(value) {
  try {
    if (!isRecord(value)) return Object.freeze({});
    const result = {};
    for (const [category, boost] of Object.entries(value)) {
      const key = normalizeText(category, 512).toLocaleLowerCase();
      if (key) result[key] = finiteNumber(boost, 0);
    }
    return Object.freeze(result);
  } catch { return Object.freeze({}); }
}

function normalizeLimit(value, fallback = MAX_ITEMS) {
  try {
    if (value === Infinity) return MAX_ITEMS;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_ITEMS, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function matchesRule(item, rule) {
  try {
    const id = normalizeId(item);
    const category = normalizeText(item.category ?? item.categoryName ?? item.topic, 512).toLocaleLowerCase();
    const channel = normalizeText(item.channelId ?? item.channel?.id ?? item.authorId, 512).toLocaleLowerCase();
    const views = nonNegative(item.views ?? item.viewCount ?? item.viewsCount, 0);
    return (!rule.id || rule.id === id)
      && (!rule.category || rule.category === category)
      && (!rule.channel || rule.channel === channel)
      && (rule.minViews === null || views >= rule.minViews);
  } catch { return false; }
}

function freezeList(items) {
  try { return Object.freeze(items.slice()); }
  catch { return Object.freeze([]); }
}

function compareRanked(left, right) {
  try {
    if (right.pinned !== left.pinned) return right.pinned ? 1 : -1;
    if (right.score !== left.score) return right.score - left.score;
    if (right.publishedAt !== left.publishedAt) return right.publishedAt - left.publishedAt;
    return left.index - right.index;
  } catch { return 0; }
}

/**
 * Deterministically score and rank caller-provided videos using views, age,
 * engagement, configured boosts, and pin rules. This class never fetches or
 * simulates trends; it only ranks data passed to it by the caller.
 */
export class TrendingDiscoveryRanker {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._listeners = new Set();
      this.now = normalizeTimestamp(settings.now, Date.now());
      this.config = normalizeConfig(settings);
      this.weights = this.config.weights;
      this._load();
      if (isRecord(settings.config)) this.updateConfig(settings.config, { silent: true, persist: false });
    } catch (error) {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._listeners = new Set();
      this.now = Date.now();
      this.config = normalizeConfig();
      this.weights = this.config.weights;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Trending ranking operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Keep error handlers isolated. */ }
    } catch { /* Error reporting must not disrupt ranking. */ }
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
      const parsed = JSON.parse(serialized);
      if (!isRecord(parsed) || !isRecord(parsed.config)) return false;
      this.config = normalizeConfig(parsed.config, this.config);
      this.weights = this.config.weights;
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, config: this.config });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type) {
    try {
      const event = Object.freeze({ type, config: this.getConfig() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _getNow(override) {
    try { return normalizeTimestamp(override, this.now); }
    catch { return this.now; }
  }

  _engagementRate(item) {
    try {
      const views = nonNegative(item.views ?? item.viewCount ?? item.viewsCount, 0);
      const direct = item.engagementRate ?? item.engagement_rate;
      if (direct !== undefined && direct !== null && direct !== "") {
        const rate = nonNegative(direct, 0);
        return clamp(rate > 1 ? rate / 100 : rate, 0, 1);
      }
      if (views <= 0) return 0;
      const likes = nonNegative(item.likes ?? item.likeCount, 0);
      const comments = nonNegative(item.comments ?? item.commentCount, 0);
      const shares = nonNegative(item.shares ?? item.shareCount, 0);
      return clamp((likes + comments + shares) / views, 0, 1);
    } catch { return 0; }
  }

  _publishedAt(item) {
    try {
      return normalizeTimestamp(item.publishedAt ?? item.publishedAtTimestamp ?? item.createdAt ?? item.uploadedAt ?? item.timestamp, 0);
    } catch { return 0; }
  }

  _matchesTimeWindow(item, now, windowMs) {
    try {
      if (windowMs === null || windowMs === undefined) return true;
      const timestamp = this._publishedAt(item);
      return timestamp > 0 && Math.max(0, now - timestamp) <= windowMs;
    } catch { return false; }
  }

  _matchesCategory(item, categoryFilter) {
    try {
      if (!categoryFilter.size) return true;
      const category = normalizeText(item.category ?? item.categoryName ?? item.topic, 512).toLocaleLowerCase();
      return categoryFilter.has(category);
    } catch { return false; }
  }

  _ruleAdjustments(item, config) {
    try {
      let boost = 0;
      let pinned = config.pinnedIds.includes(normalizeId(item)) || item.pinned === true || item.isPinned === true;
      for (const rule of config.boostRules) {
        if (matchesRule(item, rule)) {
          boost += rule.boost;
          pinned = pinned || rule.pinned;
        }
      }
      for (const rule of config.pinRules) {
        if (matchesRule(item, rule)) {
          pinned = true;
          boost += rule.boost;
        }
      }
      const category = normalizeText(item.category ?? item.categoryName ?? item.topic, 512).toLocaleLowerCase();
      boost += finiteNumber(config.categoryBoosts[category], 0);
      if (config.boostedIds.includes(normalizeId(item))) boost += 1;
      return { boost, pinned };
    } catch { return { boost: 0, pinned: false }; }
  }

  /** Compute a finite, deterministic score for one supplied video item. */
  computeScore(item, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(item)) return 0;
      const settings = isRecord(options) ? options : {};
      const config = settings.config ? normalizeConfig(settings.config, this.config) : this.config;
      const weights = settings.weights ? normalizeWeights(settings.weights, config.weights) : config.weights;
      const now = this._getNow(settings.now);
      const views = nonNegative(item.views ?? item.viewCount ?? item.viewsCount, 0);
      const viewSignal = views === 0 ? 0 : clamp(Math.log1p(views) / Math.log1p(config.viewsScale), 0, 1);
      const publishedAt = this._publishedAt(item);
      const age = publishedAt > 0 ? Math.max(0, now - publishedAt) : Infinity;
      const recency = config.halfLifeMs > 0 && Number.isFinite(age) ? Math.pow(0.5, age / config.halfLifeMs) : 0;
      const engagementRate = this._engagementRate(item);
      const adjustments = this._ruleAdjustments(item, config);
      const score = viewSignal * weights.views
        + recency * weights.recency
        + engagementRate * weights.engagementRate
        + adjustments.boost * weights.boost
        + (adjustments.pinned ? weights.pin : 0);
      return Number.isFinite(score) ? score : 0;
    } catch (error) { this._reportError(error); return 0; }
  }

  /** Rank supplied videos; optional category, age-window, and minimum-score filters apply before pagination. */
  rank(items, options = {}) {
    try {
      if (this.isDestroyed || !Array.isArray(items)) return Object.freeze([]);
      const settings = isRecord(options) ? options : {};
      const config = settings.config ? normalizeConfig(settings.config, this.config) : this.config;
      const now = this._getNow(settings.now);
      const categoryFilter = normalizeSet(settings.categories ?? settings.category).reduce((set, value) => (set.add(value.toLocaleLowerCase()), set), new Set());
      const windowCandidate = settings.timeWindowMs ?? settings.windowMs ?? config.timeWindowMs;
      const timeWindowMs = windowCandidate === null || windowCandidate === undefined ? null : nonNegative(windowCandidate, 0);
      const minScore = finiteNumber(settings.minScore, config.minScore);
      const limit = normalizeLimit(settings.limit ?? config.maxResults, config.maxResults);
      const offset = normalizeLimit(settings.offset ?? 0, 0);
      const ranked = [];
      const count = Math.min(items.length, MAX_ITEMS);
      for (let index = 0; index < count; index += 1) {
        const item = items[index];
        if (!isRecord(item) || !normalizeId(item)) continue;
        if (!this._matchesCategory(item, categoryFilter) || !this._matchesTimeWindow(item, now, timeWindowMs)) continue;
        const score = this.computeScore(item, { ...settings, config, now });
        if (score < minScore) continue;
        const adjustment = this._ruleAdjustments(item, config);
        ranked.push(Object.freeze({ item, score, pinned: adjustment.pinned, index, publishedAt: this._publishedAt(item) }));
      }
      ranked.sort(compareRanked);
      return freezeList(ranked.slice(offset, offset + limit).map((entry) => Object.freeze({ item: entry.item, score: entry.score, pinned: entry.pinned })));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  rankVideos(items, options = {}) { return this.rank(items, options); }
  sort(items, options = {}) { return this.rank(items, options); }
  filter(items, options = {}) {
    try { return freezeList(this.rank(items, { ...((isRecord(options)) ? options : {}), limit: MAX_ITEMS }).map((entry) => entry.item)); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  setWeights(weights, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(weights)) return false;
      return this.updateConfig({ weights: { ...this.config.weights, ...weights } }, options);
    } catch (error) { this._reportError(error); return false; }
  }

  updateWeights(weights, options = {}) { return this.setWeights(weights, options); }

  updateConfig(config, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(config)) return false;
      const settings = isRecord(options) ? options : {};
      this.config = normalizeConfig(config, this.config);
      this.weights = this.config.weights;
      if (settings.persist !== false) this._persist();
      if (settings.silent !== true) this._notify("config-updated");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  configure(config, options) { return this.updateConfig(config, options); }

  getConfig() {
    try { return Object.freeze({ ...this.config, weights: Object.freeze({ ...this.config.weights }), boostRules: freezeList(this.config.boostRules), pinRules: freezeList(this.config.pinRules), pinnedIds: freezeList(this.config.pinnedIds), boostedIds: freezeList(this.config.boostedIds), categoryBoosts: Object.freeze({ ...this.config.categoryBoosts }) }); }
    catch { return normalizeConfig(); }
  }

  setNow(value, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const timestamp = normalizeTimestamp(value, null);
      if (timestamp === null) return false;
      this.now = timestamp;
      if (isRecord(options) && options.notify === true) this._notify("time-updated");
      return true;
    } catch (error) { this._reportError(error); return false; }
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

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.config = normalizeConfig();
      this.weights = this.config.weights;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Construct a ranker safely in browser, server, or restricted-storage environments. */
export function createTrendingDiscoveryRanker(options = {}) {
  try { return new TrendingDiscoveryRanker(options); }
  catch { return null; }
}

export { DEFAULT_WEIGHTS };

export default Object.freeze({ DEFAULT_WEIGHTS, TrendingDiscoveryRanker, createTrendingDiscoveryRanker });
