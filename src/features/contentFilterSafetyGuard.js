const STORAGE_KEY = "trick-a4if-tube:content-filter-safety:v1";
const memoryStorage = new Map();
const FILTER_MODES = Object.freeze(["off", "safety", "strict"]);
const DEFAULT_MAX_TERMS = 5000;
const MAX_TERM_LENGTH = 512;
const MAX_TEXT_LENGTH = 20000;
const RATING_BLOCKLIST = new Set(["adult", "explicit", "mature", "nsfw", "18+", "r"]);

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeMatchText(value) {
  try {
    return normalizeText(value, MAX_TEXT_LENGTH).normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  } catch { return normalizeText(value, MAX_TEXT_LENGTH).toLowerCase(); }
}

function normalizeMode(value, fallback = "safety") {
  try {
    const mode = normalizeText(value, 32).toLowerCase();
    return FILTER_MODES.includes(mode) ? mode : fallback;
  } catch { return fallback; }
}

function normalizeLimit(value) {
  try {
    const limit = Number(value);
    return Number.isFinite(limit) ? Math.min(DEFAULT_MAX_TERMS, Math.max(0, Math.floor(limit))) : DEFAULT_MAX_TERMS;
  } catch { return DEFAULT_MAX_TERMS; }
}

function normalizeTerms(value) {
  try {
    const source = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    const unique = new Map();
    for (const candidate of source) {
      const term = normalizeText(candidate, MAX_TERM_LENGTH);
      const key = normalizeMatchText(term);
      if (key && !unique.has(key)) unique.set(key, term);
      if (unique.size >= DEFAULT_MAX_TERMS) break;
    }
    return [...unique.values()];
  } catch { return []; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function collectText(value, result = []) {
  try {
    if (Array.isArray(value)) {
      for (const part of value) collectText(part, result);
    } else if (typeof value === "string" || typeof value === "number") {
      const text = normalizeMatchText(value);
      if (text) result.push(text);
    }
    return result;
  } catch { return result; }
}

function itemFields(item) {
  try {
    const source = isRecord(item) ? item : {};
    return {
      title: collectText(source.title ?? source.name).join(" "),
      description: collectText(source.description ?? source.summary).join(" "),
      tags: collectText(source.tags ?? source.tag).join(" "),
      category: collectText(source.category ?? source.categories).join(" "),
      channel: collectText(source.channelId ?? source.channelID ?? source.channelName ?? source.channel ?? source.creator ?? source.author ?? source.uploader).join(" "),
      identifiers: collectText(source.id ?? source.videoId ?? source.videoID ?? source.key).join(" "),
    };
  } catch { return { title: "", description: "", tags: "", category: "", channel: "", identifiers: "" }; }
}

function normalizeIdentifier(value) {
  try { return normalizeText(value, MAX_TERM_LENGTH).toLocaleLowerCase(); }
  catch { return ""; }
}

/**
 * Local content policy guard for caller-supplied items. It does not retrieve,
 * generate, or alter remote content; filtering decisions are based on item
 * fields and policy terms configured by the caller.
 */
export class ContentFilterSafetyGuard {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxTerms = normalizeLimit(settings.maxTerms ?? settings.maxBlockedItems);
      this.mode = normalizeMode(settings.mode ?? (settings.strict === true ? "strict" : undefined));
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._subscribers = new Set();
      this.blockedKeywords = normalizeTerms(settings.blockedKeywords ?? settings.keywords);
      this.blockedTags = normalizeTerms(settings.blockedTags ?? settings.tags);
      this.blockedChannelIds = normalizeTerms(settings.blockedChannelIds ?? settings.channelIds).map(normalizeIdentifier);
      this.blockedChannelNames = normalizeTerms(settings.blockedChannelNames ?? settings.channelNames).map(normalizeMatchText);
      this.blockedVideoIds = normalizeTerms(settings.blockedVideoIds ?? settings.videoIds).map(normalizeIdentifier);
      this._load();
    } catch (error) {
      this._reportError(error);
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxTerms = DEFAULT_MAX_TERMS;
      this.mode = "safety";
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._subscribers = new Set();
      this.blockedKeywords = [];
      this.blockedTags = [];
      this.blockedChannelIds = [];
      this.blockedChannelNames = [];
      this.blockedVideoIds = [];
    }
  }

  setMode(mode) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeMode(mode, "");
      if (!normalized || normalized === this.mode) return Boolean(normalized);
      this.mode = normalized;
      this._persist();
      this._notify("mode-changed");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  setStrictMode(enabled) { return this.setMode(enabled ? "strict" : "safety"); }
  enableStrictMode() { return this.setMode("strict"); }
  enableSafetyMode() { return this.setMode("safety"); }
  disableFiltering() { return this.setMode("off"); }

  addBlockedKeyword(value) { return this._addTerm("blockedKeywords", value, "keyword-added"); }
  removeBlockedKeyword(value) { return this._removeTerm("blockedKeywords", value, "keyword-removed"); }
  addBlockedTag(value) { return this._addTerm("blockedTags", value, "tag-added"); }
  removeBlockedTag(value) { return this._removeTerm("blockedTags", value, "tag-removed"); }
  addBlockedChannelId(value) { return this._addTerm("blockedChannelIds", value, "channel-id-added", true); }
  removeBlockedChannelId(value) { return this._removeTerm("blockedChannelIds", value, "channel-id-removed", true); }
  addBlockedChannelName(value) { return this._addTerm("blockedChannelNames", value, "channel-name-added", true); }
  removeBlockedChannelName(value) { return this._removeTerm("blockedChannelNames", value, "channel-name-removed", true); }
  addBlockedVideoId(value) { return this._addTerm("blockedVideoIds", value, "video-id-added", true); }
  removeBlockedVideoId(value) { return this._removeTerm("blockedVideoIds", value, "video-id-removed", true); }

  setBlockedKeywords(values) { return this._setTerms("blockedKeywords", values, "keywords-updated"); }
  setBlockedTags(values) { return this._setTerms("blockedTags", values, "tags-updated"); }
  setBlockedChannelIds(values) { return this._setTerms("blockedChannelIds", values, "channel-ids-updated", true); }
  setBlockedChannelNames(values) { return this._setTerms("blockedChannelNames", values, "channel-names-updated", true); }
  setBlockedVideoIds(values) { return this._setTerms("blockedVideoIds", values, "video-ids-updated", true); }

  /** Evaluate one caller-supplied item and return an explainable decision. */
  evaluateItem(item) {
    try {
      if (!isRecord(item)) return Object.freeze({ allowed: false, matched: Object.freeze(["invalid-item"]), reasons: Object.freeze(["invalid-item"]) });
      if (this.isDestroyed || this.mode === "off") return Object.freeze({ allowed: true, matched: Object.freeze([]), reasons: Object.freeze([]) });
      const fields = itemFields(item);
      const matches = [];
      const videoId = normalizeIdentifier(item.videoId ?? item.videoID ?? item.id ?? item.key);
      const channelId = normalizeIdentifier(item.channelId ?? item.channelID ?? item.channel?.id ?? item.creator?.id);
      const channelName = normalizeMatchText(item.channelName ?? item.channel?.name ?? item.channel ?? item.creator?.name ?? item.author ?? item.uploader);
      const tags = normalizeTerms(item.tags ?? item.tag).map(normalizeMatchText);

      if (videoId && this.blockedVideoIds.includes(videoId)) matches.push(`blocked-video-id:${videoId}`);
      if (channelId && this.blockedChannelIds.includes(channelId)) matches.push(`blocked-channel-id:${channelId}`);
      for (const blockedName of this.blockedChannelNames) {
        if (blockedName && (channelName === blockedName || channelName.includes(blockedName))) matches.push(`blocked-channel-name:${blockedName}`);
      }
      for (const blockedTag of this.blockedTags) {
        const normalizedTag = normalizeMatchText(blockedTag);
        if (normalizedTag && tags.some((tag) => tag === normalizedTag || tag.split(" ").includes(normalizedTag))) matches.push(`blocked-tag:${normalizedTag}`);
      }
      const searchableText = [fields.title, fields.description, fields.category].join(" ");
      for (const blockedWord of this.blockedKeywords) {
        const keyword = normalizeMatchText(blockedWord);
        if (keyword && searchableText.includes(keyword)) matches.push(`blocked-keyword:${keyword}`);
      }

      const explicitFlag = item.isAdult === true || item.explicit === true || item.isExplicit === true || item.nsfw === true;
      const safetyFlag = item.isSafe ?? item.safeContent ?? item.safe;
      const rating = normalizeMatchText(item.contentRating ?? item.rating ?? item.ageRating);
      if (explicitFlag || safetyFlag === false || RATING_BLOCKLIST.has(rating)) matches.push("unsafe-content-flag");
      if (this.mode === "strict") {
        if (safetyFlag !== true && !explicitFlag && !rating) matches.push("strict-mode-unrated");
        if (item.ageRestricted === true || item.restricted === true) matches.push("age-restricted");
      }
      const uniqueMatches = Object.freeze([...new Set(matches)]);
      return Object.freeze({ allowed: uniqueMatches.length === 0, matched: uniqueMatches, reasons: uniqueMatches });
    } catch (error) {
      this._reportError(error);
      return Object.freeze({ allowed: false, matched: Object.freeze(["evaluation-error"]), reasons: Object.freeze(["evaluation-error"]) });
    }
  }

  isItemAllowed(item) {
    try { return this.evaluateItem(item).allowed; }
    catch (error) { this._reportError(error); return false; }
  }

  /** Return an immutable list containing only allowed items; originals are untouched. */
  filterItems(items, options = {}) {
    try {
      if (!Array.isArray(items)) return Object.freeze([]);
      if (options?.includeDecisions === true) {
        return Object.freeze(items.filter(isRecord).map((item) => Object.freeze({ item, ...this.evaluateItem(item) }))
          .filter((entry) => entry.allowed));
      }
      return Object.freeze(items.filter((item) => this.isItemAllowed(item)));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  filter(items, options) { return this.filterItems(items, options); }
  sanitizeItems(items) { return this.filterItems(items); }
  sanitize(items) { return this.filterItems(items); }

  getBlockedItems() {
    try {
      return Object.freeze({
        keywords: Object.freeze(this.blockedKeywords.slice()),
        tags: Object.freeze(this.blockedTags.slice()),
        channelIds: Object.freeze(this.blockedChannelIds.slice()),
        channelNames: Object.freeze(this.blockedChannelNames.slice()),
        videoIds: Object.freeze(this.blockedVideoIds.slice()),
      });
    } catch { return Object.freeze({ keywords: Object.freeze([]), tags: Object.freeze([]), channelIds: Object.freeze([]), channelNames: Object.freeze([]), videoIds: Object.freeze([]) }); }
  }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* Safe unsubscribe. */ } };
    } catch { return () => {}; }
  }

  getState() {
    try { return Object.freeze({ mode: this.mode, strict: this.mode === "strict", blocked: this.getBlockedItems(), isDestroyed: this.isDestroyed }); }
    catch { return null; }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._persist();
      this.isDestroyed = true;
      this._subscribers.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; this._subscribers.clear(); return false; }
  }

  _addTerm(field, value, reason, identifier = false) {
    try {
      if (this.isDestroyed) return false;
      const original = normalizeText(value, MAX_TERM_LENGTH);
      const term = identifier ? normalizeIdentifier(original) : original;
      const key = normalizeMatchText(term);
      if (!key || this[field].some((entry) => normalizeMatchText(entry) === key)) return false;
      if (this[field].length >= this.maxTerms) return false;
      this[field] = [...this[field], term];
      this._persist();
      this._notify(reason);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _removeTerm(field, value, reason, identifier = false) {
    try {
      if (this.isDestroyed) return false;
      const candidate = identifier ? normalizeIdentifier(value) : normalizeText(value, MAX_TERM_LENGTH);
      const key = normalizeMatchText(candidate);
      const next = this[field].filter((entry) => normalizeMatchText(entry) !== key);
      if (next.length === this[field].length) return false;
      this[field] = next;
      this._persist();
      this._notify(reason);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _setTerms(field, values, reason, identifier = false) {
    try {
      if (this.isDestroyed) return false;
      const next = normalizeTerms(values).slice(0, this.maxTerms).map((value) => identifier ? normalizeIdentifier(value) : value);
      this[field] = [...new Set(next.filter(Boolean))];
      this._persist();
      this._notify(reason);
      return true;
    } catch (error) { this._reportError(error); return false; }
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
      if (!isRecord(payload) || payload.version !== 1) return;
      this.mode = normalizeMode(payload.mode, this.mode);
      const blocked = isRecord(payload.blocked) ? payload.blocked : payload;
      this.blockedKeywords = normalizeTerms(blocked.keywords ?? blocked.blockedKeywords).slice(0, this.maxTerms);
      this.blockedTags = normalizeTerms(blocked.tags ?? blocked.blockedTags).slice(0, this.maxTerms);
      this.blockedChannelIds = normalizeTerms(blocked.channelIds ?? blocked.blockedChannelIds).map(normalizeIdentifier).filter(Boolean).slice(0, this.maxTerms);
      this.blockedChannelNames = normalizeTerms(blocked.channelNames ?? blocked.blockedChannelNames).map(normalizeMatchText).filter(Boolean).slice(0, this.maxTerms);
      this.blockedVideoIds = normalizeTerms(blocked.videoIds ?? blocked.blockedVideoIds).map(normalizeIdentifier).filter(Boolean).slice(0, this.maxTerms);
    } catch (error) { this._reportError(error); }
  }

  _persist() {
    try {
      const value = JSON.stringify({ version: 1, mode: this.mode, blocked: this.getBlockedItems() });
      memoryStorage.set(this.storageKey, value);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, value); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(reason) {
    try {
      const event = Object.freeze({ reason, state: this.getState() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Content safety filter operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callbacks. */ }
    } catch { /* Error handling must not interrupt filtering. */ }
  }
}

/** Create a local content safety guard without throwing on setup failures. */
export function createContentFilterSafetyGuard(options = {}) {
  try { return new ContentFilterSafetyGuard(options); }
  catch { return null; }
}

export { FILTER_MODES };
export default Object.freeze({ ContentFilterSafetyGuard, createContentFilterSafetyGuard, FILTER_MODES });
