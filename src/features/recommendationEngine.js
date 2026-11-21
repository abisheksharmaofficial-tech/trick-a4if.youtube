const DEFAULT_WEIGHTS = Object.freeze({
  categoryAffinity: 18,
  tagAffinity: 12,
  searchMatch: 14,
  subscribedChannel: 16,
  positiveReaction: 14,
  watchHistory: 8,
  watchLater: 12,
  bookmark: 10,
  recency: 8,
  popularity: 8,
  hiddenPenalty: -100,
  dislikedPenalty: -30,
  completedPenalty: -20,
  alreadyWatchedPenalty: -4,
});

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, limit = 4096) {
  try {
    return typeof value === "string" ? value.trim().slice(0, limit) : "";
  } catch {
    return "";
  }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) {
      return normalizeText(value.videoId ?? value.id ?? value.key, 512);
    }
    return normalizeText(value, 512);
  } catch {
    return "";
  }
}

function toFiniteNumber(value, fallback = 0) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeNonNegativeNumber(value, fallback = 0) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTimestamp(value) {
  try {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    if (number > 0 && number < 100000000000) return number * 1000;
    return number;
  } catch {
    return null;
  }
}

function normalizeTags(value) {
  try {
    const values = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : [];
    const tags = new Map();
    for (const candidate of values) {
      const tag = normalizeText(candidate, 128).toLowerCase();
      if (tag) tags.set(tag, true);
    }
    return [...tags.keys()];
  } catch {
    return [];
  }
}

function getCandidateId(candidate) {
  try {
    return normalizeId(candidate?.videoId ?? candidate?.id ?? candidate?.key);
  } catch {
    return "";
  }
}

function getCollectionValue(value, keyNames) {
  try {
    if (!isRecord(value) && typeof value !== "object") return null;
    for (const key of keyNames) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    }
    return null;
  } catch {
    return null;
  }
}

function addToSet(set, values) {
  try {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      const id = normalizeId(value);
      if (id) set.add(id);
    }
  } catch {
    // Keep an existing set usable if collection parsing fails.
  }
}

function addRecordIds(set, values, idKeys) {
  try {
    if (!Array.isArray(values) && !isRecord(values)) return;
    const entries = Array.isArray(values) ? values : Object.keys(values).map((key) => values[key]);
    for (const entry of entries) {
      let id = "";
      if (typeof entry === "string") id = normalizeId(entry);
      else if (isRecord(entry)) {
        for (const key of idKeys) {
          id = normalizeId(entry[key]);
          if (id) break;
        }
      }
      if (id) set.add(id);
    }
  } catch {
    // Ignore malformed signal entries.
  }
}

function getCategoryAffinity(categories) {
  try {
    if (isRecord(categories)) return new Map(
      Object.entries(categories)
        .map(([category, weight]) => [
          normalizeText(category, 512).toLowerCase(),
          normalizeNonNegativeNumber(weight),
        ])
        .filter(([category, weight]) => category && weight > 0),
    );
    if (Array.isArray(categories)) {
      return new Map(categories
        .map((category) => normalizeText(category, 512).toLowerCase())
        .filter(Boolean)
        .map((category) => [category, 1]));
    }
    return new Map();
  } catch {
    return new Map();
  }
}

function getTagAffinity(tags) {
  try {
    if (isRecord(tags)) return new Map(
      Object.entries(tags)
        .map(([tag, weight]) => [
          normalizeText(tag, 128).toLowerCase(),
          normalizeNonNegativeNumber(weight),
        ])
        .filter(([tag, weight]) => tag && weight > 0),
    );
    if (Array.isArray(tags)) {
      return new Map(tags
        .map((tag) => normalizeText(tag, 128).toLowerCase())
        .filter(Boolean)
        .map((tag) => [tag, 1]));
    }
    return new Map();
  } catch {
    return new Map();
  }
}

function normalizeWeights(value) {
  try {
    const weights = isRecord(value) ? value : {};
    const normalized = {};
    for (const [key, fallback] of Object.entries(DEFAULT_WEIGHTS)) {
      const candidate = weights[key];
      if (candidate === null || candidate === undefined) {
        normalized[key] = fallback;
        continue;
      }
      const number = Number(candidate);
      normalized[key] = Number.isFinite(number) ? number : fallback;
    }
    return Object.freeze(normalized);
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

function extractText(item) {
  try {
    return [
      normalizeText(item?.title, 1024),
      normalizeText(item?.description, 4096),
      normalizeText(item?.channelName, 512),
      normalizeText(item?.channel, 512),
      normalizeText(item?.author, 512),
      normalizeText(item?.category, 512),
      ...normalizeTags(item?.tags),
    ].join(" ").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeSearchQueries(value) {
  try {
    if (Array.isArray(value)) {
      return value.map((query) => normalizeText(query, 1024).toLowerCase()).filter(Boolean);
    }
    const text = normalizeText(value, 4096).toLowerCase();
    return text ? [text] : [];
  } catch {
    return [];
  }
}

function intersectionRatio(a, b) {
  try {
    if (!a.size || !b.size) return 0;
    let matches = 0;
    for (const value of b) {
      if (a.has(value)) matches += 1;
    }
    return matches / a.size;
  } catch {
    return 0;
  }
}

function clamp(value, minimum, maximum) {
  try {
    return Math.min(maximum, Math.max(minimum, value));
  } catch {
    return minimum;
  }
}

function rankSort(left, right) {
  try {
    if (right.score !== left.score) return right.score - left.score;
    const rightTimestamp = normalizeTimestamp(right.item?.publishedAt
      ?? right.item?.publishedAtTimestamp
      ?? right.item?.createdAt
      ?? right.item?.addedAt) ?? 0;
    const leftTimestamp = normalizeTimestamp(left.item?.publishedAt
      ?? left.item?.publishedAtTimestamp
      ?? left.item?.createdAt
      ?? left.item?.addedAt) ?? 0;
    if (rightTimestamp !== leftTimestamp) return rightTimestamp - leftTimestamp;
    return left.rankIndex - right.rankIndex;
  } catch {
    return 0;
  }
}

/**
 * Rank caller-provided video candidates using local state signals. This class
 * does not fetch data or simulate recommendations; it only evaluates objects
 * supplied through its options or rank() arguments.
 */
export class RecommendationEngine {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.weights = normalizeWeights(settings.weights);
    this.now = normalizeTimestamp(settings.now) ?? Date.now();
    this.recencyWindowMs = normalizeNonNegativeNumber(
      settings.recencyWindowMs ?? 180 * 24 * 60 * 60 * 1000,
      180 * 24 * 60 * 60 * 1000,
    );
    this.maxResults = normalizeNonNegativeNumber(settings.maxResults ?? 50, 50);
    this.includeScoreBreakdown = settings.includeScoreBreakdown !== false;
    this.lastError = null;
    this.isDestroyed = false;

    this.categoryAffinity = getCategoryAffinity(
      settings.categoryAffinity ?? settings.categoryWeights ?? settings.categories,
    );
    this.tagAffinity = getTagAffinity(
      settings.tagAffinity ?? settings.tagWeights ?? settings.tags,
    );

    this.searchQueries = normalizeSearchQueries(
      settings.searchQueries ?? settings.searches ?? settings.queries,
    );

    this.hiddenIds = new Set();
    this.dislikedIds = new Set();
    this.completedIds = new Set();
    this.watchedIds = new Set();
    this.subscribedChannelIds = new Set();
    this.watchLaterIds = new Set();
    this.bookmarkedIds = new Set();
    this.likedIds = new Set();
    this.positiveReactionIds = new Set();

    this._loadSignals(settings);
  }

  _loadSignals(settings) {
    try {
      const hidden = settings.hiddenIds ?? settings.hiddenItems ?? settings.hidden;
      addToSet(this.hiddenIds, hidden);
      addRecordIds(this.hiddenIds, hidden, ["videoId", "id", "key"]);

      const disliked = settings.dislikedIds ?? settings.dislikedItems ?? settings.disliked;
      addToSet(this.dislikedIds, disliked);
      addRecordIds(this.dislikedIds, disliked, ["videoId", "id", "key"]);
      addRecordIds(this.dislikedIds, isRecord(settings.reactions) ? settings.reactions : null, ["videoId", "id"]);

      if (isRecord(settings.reactions)) {
        for (const [key, value] of Object.entries(settings.reactions)) {
          const reaction = isRecord(value) ? value.reaction ?? value.type : value;
          const id = normalizeId(isRecord(value) ? value.videoId ?? value.id ?? key : key);
          if (!id) continue;
          if (String(reaction).toLowerCase() === "dislike") this.dislikedIds.add(id);
          if (["like", "love", "insightful", "fire", "clap"].includes(String(reaction).toLowerCase())) {
            this.positiveReactionIds.add(id);
            this.likedIds.add(id);
          }
        }
      }

      const reactionArray = settings.reactions;
      if (Array.isArray(reactionArray)) {
        for (const reaction of reactionArray) {
          if (!isRecord(reaction)) continue;
          const id = normalizeId(reaction.videoId ?? reaction.id);
          const type = normalizeText(reaction.reaction ?? reaction.type, 64).toLowerCase();
          if (!id) continue;
          if (type === "dislike") this.dislikedIds.add(id);
          if (["like", "love", "insightful", "fire", "clap"].includes(type)) {
            this.positiveReactionIds.add(id);
            this.likedIds.add(id);
          }
        }
      }

      addRecordIds(this.watchedIds, settings.watchHistory ?? settings.watchHistoryItems ?? settings.history, ["videoId", "id", "key"]);
      addRecordIds(this.completedIds, settings.completedIds ?? settings.completedItems ?? settings.completed, ["videoId", "id", "key"]);

      if (Array.isArray(settings.watchHistory ?? settings.history)) {
        const history = settings.watchHistory ?? settings.history;
        for (const item of history) {
          if (!isRecord(item)) continue;
          const id = normalizeId(item.videoId ?? item.id);
          if (id && (item.progress >= 0.95 || item.watched === true || item.completed === true)) {
            this.completedIds.add(id);
          }
        }
      }

      addRecordIds(
        this.subscribedChannelIds,
        settings.channelSubscriptions ?? settings.subscriptions ?? settings.channels,
        ["channelId", "id", "key"],
      );

      addRecordIds(this.watchLaterIds, settings.watchLater ?? settings.watchLaterItems, ["videoId", "id", "key"]);
      addRecordIds(this.bookmarkedIds, settings.bookmarks ?? settings.bookmarkItems, ["videoId", "id", "key"]);
    } catch (error) {
      this._reportError(error);
    }
  }

  updateAffinities(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (isRecord(options.categoryAffinity) || Array.isArray(options.categoryAffinity)) {
        this.categoryAffinity = getCategoryAffinity(options.categoryAffinity);
      }
      if (isRecord(options.categories) || Array.isArray(options.categories)) {
        this.categoryAffinity = getCategoryAffinity(options.categories);
      }
      if (isRecord(options.tagAffinity) || Array.isArray(options.tagAffinity)) {
        this.tagAffinity = getTagAffinity(options.tagAffinity);
      }
      if (isRecord(options.tags) || Array.isArray(options.tags)) {
        this.tagAffinity = getTagAffinity(options.tags);
      }
      if (options.weights != null) this.weights = normalizeWeights(options.weights);
      if (options.searchQueries != null || options.queries != null || options.searches != null) {
        this.searchQueries = normalizeSearchQueries(
          options.searchQueries ?? options.queries ?? options.searches,
        );
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  setSignals(signals = {}) {
    try {
      if (this.isDestroyed || !isRecord(signals)) return false;
      this.hiddenIds.clear();
      this.dislikedIds.clear();
      this.completedIds.clear();
      this.watchedIds.clear();
      this.subscribedChannelIds.clear();
      this.watchLaterIds.clear();
      this.bookmarkedIds.clear();
      this.positiveReactionIds.clear();
      this.likedIds.clear();
      this._loadSignals(signals);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error
        ? error
        : new Error("Recommendation ranking failed.");
      if (typeof this.onError === "function") this.onError(this.lastError, this);
    } catch {
      // Reporting must never interrupt ranking.
    }
  }

  _candidateCategory(item) {
    try {
      const category = normalizeText(
        item?.category ?? item?.categoryName ?? item?.topic,
        512,
      ).toLowerCase();
      return category;
    } catch {
      return "";
    }
  }

  _candidateTags(item) {
    try {
      const combined = [];
      if (Array.isArray(item?.tags)) combined.push(...item.tags);
      if (Array.isArray(item?.categories)) combined.push(...item.categories);
      if (typeof item?.category === "string") combined.push(item.category);
      return new Set(normalizeTags(combined).map((tag) => tag.toLowerCase()));
    } catch {
      return new Set();
    }
  }

  _channelId(item) {
    try {
      return normalizeId(
        item?.channelId
        ?? item?.channel?.id
        ?? item?.authorId
        ?? item?.uploaderId,
      );
    } catch {
      return "";
    }
  }

  _popularity(item) {
    try {
      const value = item?.popularityScore
        ?? item?.popularity
        ?? item?.views
        ?? item?.viewCount
        ?? item?.score;
      const number = normalizeNonNegativeNumber(value, 0);
      if (number <= 0) return 0;
      if (number > 1_000_000) return clamp(Math.log10(number + 1) / 9, 0, 1);
      if (number <= 1) return clamp(number, 0, 1);
      return clamp(Math.log10(number + 1) / 7, 0, 1);
    } catch {
      return 0;
    }
  }

  _recency(item) {
    try {
      const timestamp = normalizeTimestamp(
        item?.publishedAt
        ?? item?.publishedAtTimestamp
        ?? item?.createdAt
        ?? item?.addedAt
        ?? item?.timestamp,
      );
      if (timestamp === null) return 0;
      const age = Math.max(0, this.now - timestamp);
      if (age >= this.recencyWindowMs) return 0;
      return clamp(1 - age / this.recencyWindowMs, 0, 1);
    } catch {
      return 0;
    }
  }

  _searchScore(item) {
    try {
      if (!this.searchQueries.length) return 0;
      const text = extractText(item);
      let matches = 0;
      for (const query of this.searchQueries) {
        if (!query) continue;
        if (text.includes(query)) matches += 1;
        else {
          const terms = query.split(/\s+/).filter((term) => term.length >= 2);
          if (terms.length && terms.every((term) => text.includes(term))) matches += 0.75;
        }
      }
      return clamp(matches / this.searchQueries.length, 0, 1);
    } catch {
      return 0;
    }
  }

  _categoryScore(category) {
    try {
      if (!category || !this.categoryAffinity.size) return 0;
      const affinity = this.categoryAffinity.get(category);
      if (affinity === undefined) return 0;
      const maximum = Math.max(...this.categoryAffinity.values(), 1);
      return clamp(affinity / maximum, 0, 1);
    } catch {
      return 0;
    }
  }

  _tagScore(candidateTags) {
    try {
      if (!candidateTags.size || !this.tagAffinity.size) return 0;
      let total = 0;
      let matched = 0;
      for (const tag of candidateTags) {
        const affinity = this.tagAffinity.get(tag);
        if (affinity === undefined) continue;
        matched += 1;
        total += affinity;
      }
      if (!matched) return 0;
      const maximum = Math.max(...this.tagAffinity.values(), 1);
      return clamp((total / matched) / maximum, 0, 1);
    } catch {
      return 0;
    }
  }

  /** Rank candidates and return the top results in descending score order. */
  rank(candidates, options = {}) {
    try {
      if (this.isDestroyed) return Object.freeze([]);
      if (!Array.isArray(candidates)) return Object.freeze([]);

      const settings = isRecord(options) ? options : {};
      const weights = settings.weights == null
        ? this.weights
        : normalizeWeights({ ...this.weights, ...settings.weights });
      const limit = settings.limit == null
        ? this.maxResults
        : normalizeNonNegativeNumber(settings.limit, this.maxResults);
      const includeBreakdown = settings.includeScoreBreakdown ?? this.includeScoreBreakdown;

      const customHidden = new Set(this.hiddenIds);
      const customDisliked = new Set(this.dislikedIds);
      const customCompleted = new Set(this.completedIds);

      addToSet(customHidden, settings.hiddenIds);
      addToSet(customDisliked, settings.dislikedIds);
      addToSet(customCompleted, settings.completedIds);
      addRecordIds(customHidden, settings.hiddenItems, ["videoId", "id", "key"]);
      addRecordIds(customDisliked, settings.dislikedItems, ["videoId", "id", "key"]);
      addRecordIds(customCompleted, settings.completedItems, ["videoId", "id", "key"]);

      const ranked = [];

      for (let rankIndex = 0; rankIndex < candidates.length; rankIndex += 1) {
        const item = candidates[rankIndex];
        if (!isRecord(item)) continue;
        const id = getCandidateId(item);
        if (!id) continue;

        if (customHidden.has(id) || item.hidden === true || item.isHidden === true) {
          continue;
        }

        const category = this._candidateCategory(item);
        const candidateTags = this._candidateTags(item);
        const searchScore = this._searchScore(item);
        const categoryScore = this._categoryScore(category);
        const tagScore = this._tagScore(candidateTags);
        const recencyScore = this._recency(item);
        const popularityScore = this._popularity(item);

        let score = 0;
        const breakdown = {};

        const categoryPoints = categoryScore * weights.categoryAffinity;
        breakdown.categoryAffinity = categoryPoints;
        score += categoryPoints;

        const tagPoints = tagScore * weights.tagAffinity;
        breakdown.tagAffinity = tagPoints;
        score += tagPoints;

        const searchPoints = searchScore * weights.searchMatch;
        breakdown.searchMatch = searchPoints;
        score += searchPoints;

        if (this.subscribedChannelIds.has(this._channelId(item))) {
          breakdown.subscribedChannel = weights.subscribedChannel;
          score += weights.subscribedChannel;
        } else {
          breakdown.subscribedChannel = 0;
        }

        if (this.positiveReactionIds.has(id) || item.reaction === "like"
          || item.reaction === "love" || item.reaction === "insightful"
          || item.reaction === "fire" || item.reaction === "clap") {
          breakdown.positiveReaction = weights.positiveReaction;
          score += weights.positiveReaction;
        } else {
          breakdown.positiveReaction = 0;
        }

        if (this.watchedIds.has(id) || item.watched === true) {
          const progress = clamp(toFiniteNumber(
            item.progress ?? item.watchProgress ?? item.progressRatio,
            0,
          ) > 1
            ? toFiniteNumber(item.progress ?? item.watchProgress, 0) / 100
            : toFiniteNumber(item.progress ?? item.watchProgress ?? item.progressRatio, 0), 0, 1);
          const historyPoints = progress > 0
            ? weights.watchHistory * progress
            : weights.watchHistory * 0.25;
          breakdown.watchHistory = historyPoints;
          score += historyPoints;
          breakdown.alreadyWatchedPenalty = weights.alreadyWatchedPenalty;
          score += weights.alreadyWatchedPenalty;
        } else {
          breakdown.watchHistory = 0;
          breakdown.alreadyWatchedPenalty = 0;
        }

        if (this.watchLaterIds.has(id) || item.watchLater === true) {
          breakdown.watchLater = weights.watchLater;
          score += weights.watchLater;
        } else {
          breakdown.watchLater = 0;
        }

        if (this.bookmarkedIds.has(id) || item.bookmarked === true) {
          breakdown.bookmark = weights.bookmark;
          score += weights.bookmark;
        } else {
          breakdown.bookmark = 0;
        }

        const recencyPoints = recencyScore * weights.recency;
        breakdown.recency = recencyPoints;
        score += recencyPoints;

        const popularityPoints = popularityScore * weights.popularity;
        breakdown.popularity = popularityPoints;
        score += popularityPoints;

        if (item.disliked === true || customDisliked.has(id)) {
          breakdown.dislikedPenalty = weights.dislikedPenalty;
          score += weights.dislikedPenalty;
        } else {
          breakdown.dislikedPenalty = 0;
        }

        if (item.completed === true || item.watchedComplete === true
          || customCompleted.has(id) || item.progress >= 0.95) {
          breakdown.completedPenalty = weights.completedPenalty;
          score += weights.completedPenalty;
        } else {
          breakdown.completedPenalty = 0;
        }

        ranked.push({
          item,
          score,
          rankIndex,
          ...(includeBreakdown ? { scoreBreakdown: Object.freeze({ ...breakdown }) } : {}),
        });
      }

      ranked.sort(rankSort);
      const numberLimit = limit === Infinity ? ranked.length : Math.floor(limit);
      const selected = ranked.slice(0, Math.max(0, numberLimit));
      return Object.freeze(selected.map((entry) => Object.freeze(entry)));
    } catch (error) {
      this._reportError(error);
      return Object.freeze([]);
    }
  }

  recommend(candidates, options = {}) {
    return this.rank(candidates, options);
  }

  score(candidate, options = {}) {
    try {
      const result = this.rank([candidate], options);
      return result.length ? result[0] : null;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.categoryAffinity.clear();
      this.tagAffinity.clear();
      this.hiddenIds.clear();
      this.dislikedIds.clear();
      this.completedIds.clear();
      this.watchedIds.clear();
      this.subscribedChannelIds.clear();
      this.watchLaterIds.clear();
      this.bookmarkedIds.clear();
      this.positiveReactionIds.clear();
      this.likedIds.clear();
      this.searchQueries = [];
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }
}

/** Create a recommendation engine without throwing in restricted environments. */
export function createRecommendationEngine(options = {}) {
  try {
    return new RecommendationEngine(options);
  } catch {
    return null;
  }
}

export { DEFAULT_WEIGHTS };

export default Object.freeze({
  DEFAULT_WEIGHTS,
  RecommendationEngine,
  createRecommendationEngine,
});
