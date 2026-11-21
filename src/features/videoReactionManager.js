const STORAGE_KEY = "trick-a4if-tube:video-reactions";
const BUILT_IN_REACTIONS = Object.freeze(["like", "dislike", "love", "insightful", "fire", "clap"]);
const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 4096;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  try { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
  catch { return ""; }
}

function normalizeVideoId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.videoId ?? value.id ?? value.key, MAX_ID_LENGTH);
    return normalizeText(value, MAX_ID_LENGTH);
  } catch { return ""; }
}

function normalizeCount(value) {
  try {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  } catch { return 0; }
}

function normalizeReactionType(value) {
  try {
    const reaction = normalizeText(value, 64).toLowerCase();
    return reaction && /^[a-z][a-z0-9_-]*$/.test(reaction) ? reaction : "";
  } catch { return ""; }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
  } catch { return fallback; }
}

function normalizeReactionCounts(value, allowedTypes) {
  try {
    const counts = Object.create(null);
    if (!isRecord(value)) return counts;
    for (const [candidate, count] of Object.entries(value)) {
      const type = normalizeReactionType(candidate);
      if (type && allowedTypes.has(type)) counts[type] = normalizeCount(count);
    }
    return counts;
  } catch { return Object.create(null); }
}

function normalizeState(input, allowedTypes) {
  try {
    if (!isRecord(input)) return null;
    const videoId = normalizeVideoId(input.videoId ?? input.id ?? input.key);
    if (!videoId) return null;
    let reaction = input.reaction ?? input.myReaction ?? input.type ?? null;
    reaction = reaction == null || reaction === "" ? null : normalizeReactionType(reaction);
    if (reaction && !allowedTypes.has(reaction)) reaction = null;
    const counts = normalizeReactionCounts(input.counts ?? input.reactionCounts, allowedTypes);
    if (reaction && counts[reaction] === undefined) counts[reaction] = 1;
    return {
      videoId,
      reaction,
      counts,
      updatedAt: normalizeTimestamp(input.updatedAt ?? input.timestamp),
    };
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeCollection(input, allowedTypes) {
  try {
    const records = Array.isArray(input) ? input
      : isRecord(input) && Array.isArray(input.videos) ? input.videos
        : isRecord(input) && Array.isArray(input.reactions) ? input.reactions : [];
    const result = new Map();
    for (const candidate of records) {
      const state = normalizeState(candidate, allowedTypes);
      if (!state) continue;
      if (result.has(state.videoId)) result.delete(state.videoId);
      result.set(state.videoId, state);
    }
    return result;
  } catch { return new Map(); }
}

function freezeState(state) {
  try {
    if (!state) return null;
    const counts = {};
    for (const [reaction, count] of Object.entries(state.counts)) counts[reaction] = count;
    return Object.freeze({
      videoId: state.videoId,
      reaction: state.reaction,
      myReaction: state.reaction,
      counts: Object.freeze(counts),
      updatedAt: state.updatedAt,
    });
  } catch { return null; }
}

/**
 * Store the current user's reaction per video and maintain reaction counts.
 * State is persisted locally where available; no network or remote vote count
 * service is assumed. The counts represent values stored in this manager.
 */
export class VideoReactionManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.allowedReactionTypes = new Set(BUILT_IN_REACTIONS);
    const customTypes = settings.allowedReactionTypes ?? settings.reactionTypes ?? settings.customReactionTypes;
    if (Array.isArray(customTypes)) {
      for (const candidate of customTypes) {
        const type = normalizeReactionType(candidate);
        if (type) this.allowedReactionTypes.add(type);
      }
    }
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._states = new Map();
    this._listeners = new Set();
    this._load();
    const initial = settings.reactions ?? settings.videos;
    if (initial != null && this._states.size === 0) {
      this.importReactions(initial, { replace: true, silent: true });
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Video reaction operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Error callbacks remain isolated. */ }
    } catch { /* Never let reporting break data operations. */ }
  }

  _load() {
    try {
      let serialized = null;
      try { serialized = this.storage?.getItem(this.storageKey); }
      catch (error) { this._reportError(error); }
      if (typeof serialized !== "string" || !serialized) return false;
      this._states = normalizeCollection(JSON.parse(serialized), this.allowedReactionTypes);
      return true;
    } catch (error) {
      this._reportError(error);
      this._states = new Map();
      return false;
    }
  }

  _persist() {
    try {
      if (!this.storage || typeof this.storage.setItem !== "function") return false;
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, videos: this.getAllReactionStates() }));
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, videoId, previousState, details = {}) {
    try {
      const event = Object.freeze({
        type,
        videoId: videoId ?? null,
        state: videoId ? this.getReactionState(videoId) : null,
        previousState: freezeState(previousState),
        states: this.getAllReactionStates(),
        count: this._states.size,
        ...details,
      });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _commit(type, videoId, previousState, details = {}) {
    try {
      this._persist();
      this._notify(type, videoId, previousState, details);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _adjustCount(counts, type, change) {
    try {
      if (!type || !this.allowedReactionTypes.has(type)) return;
      const next = Math.max(0, normalizeCount(counts[type]) + change);
      if (next === 0) delete counts[type];
      else counts[type] = next;
    } catch { /* Invalid count adjustments are safely ignored. */ }
  }

  /** Set a reaction; pass null to clear it. Returns the resulting state. */
  setReaction(videoIdOrRecord, reaction, options = {}) {
    try {
      if (this.isDestroyed) return null;
      let id = normalizeVideoId(videoIdOrRecord);
      let selected = reaction;
      let settings = isRecord(options) ? options : {};
      if (isRecord(videoIdOrRecord)) {
        const input = videoIdOrRecord;
        id = normalizeVideoId(input.videoId ?? input.id ?? input.key);
        if (reaction === undefined) selected = input.reaction ?? input.myReaction ?? input.type ?? null;
        settings = { ...input, ...settings };
      }
      if (!id) return null;
      const normalizedReaction = selected == null || selected === "" ? null : normalizeReactionType(selected);
      if (selected != null && selected !== "" && (!normalizedReaction || !this.allowedReactionTypes.has(normalizedReaction))) return null;

      const previous = this._states.get(id) ?? null;
      const counts = Object.assign(Object.create(null), previous?.counts ?? {});
      const oldReaction = previous?.reaction ?? null;
      if (oldReaction !== normalizedReaction) {
        this._adjustCount(counts, oldReaction, -1);
        this._adjustCount(counts, normalizedReaction, 1);
      } else if (normalizedReaction && counts[normalizedReaction] === undefined) {
        counts[normalizedReaction] = 1;
      }
      if (isRecord(settings.counts)) {
        Object.assign(counts, normalizeReactionCounts(settings.counts, this.allowedReactionTypes));
      }
      const next = normalizedReaction || Object.keys(counts).length
        ? { videoId: id, reaction: normalizedReaction, counts, updatedAt: normalizeTimestamp(settings.updatedAt) }
        : null;
      if (next) this._states.set(id, next);
      else this._states.delete(id);
      this._commit(normalizedReaction ? "set" : "clear", id, previous, { reaction: normalizedReaction });
      return freezeState(next);
    } catch (error) { this._reportError(error); return null; }
  }

  react(videoIdOrRecord, reaction, options) { return this.setReaction(videoIdOrRecord, reaction, options); }

  toggleReaction(videoIdOrRecord, reaction) {
    try {
      if (this.isDestroyed) return null;
      const id = normalizeVideoId(videoIdOrRecord);
      const selected = reaction ?? (isRecord(videoIdOrRecord) ? videoIdOrRecord.reaction : null);
      const type = normalizeReactionType(selected);
      if (!id || !type || !this.allowedReactionTypes.has(type)) return null;
      const current = this._states.get(id)?.reaction ?? null;
      return this.setReaction(id, current === type ? null : type);
    } catch (error) { this._reportError(error); return null; }
  }

  toggle(videoIdOrRecord, reaction) { return this.toggleReaction(videoIdOrRecord, reaction); }

  clearReaction(videoIdOrRecord) {
    try {
      const id = normalizeVideoId(videoIdOrRecord);
      if (!id || this.isDestroyed) return false;
      const previous = this._states.get(id);
      if (!previous) return false;
      const counts = Object.assign(Object.create(null), previous.counts);
      this._adjustCount(counts, previous.reaction, -1);
      const next = Object.keys(counts).length
        ? { videoId: id, reaction: null, counts, updatedAt: Date.now() }
        : null;
      if (next) this._states.set(id, next);
      else this._states.delete(id);
      this._commit("clear", id, previous);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clear(videoIdOrRecord) { return this.clearReaction(videoIdOrRecord); }

  getReactionState(videoIdOrRecord) {
    try { return freezeState(this._states.get(normalizeVideoId(videoIdOrRecord)) ?? null); }
    catch (error) { this._reportError(error); return null; }
  }

  getReaction(videoIdOrRecord) {
    try { return this._states.get(normalizeVideoId(videoIdOrRecord))?.reaction ?? null; }
    catch { return null; }
  }

  getReactionCounts(videoIdOrRecord) {
    try { return this.getReactionState(videoIdOrRecord)?.counts ?? Object.freeze({}); }
    catch { return Object.freeze({}); }
  }

  getCount(videoIdOrRecord, reaction) {
    try {
      const type = normalizeReactionType(reaction);
      return type ? normalizeCount(this._states.get(normalizeVideoId(videoIdOrRecord))?.counts?.[type]) : 0;
    } catch { return 0; }
  }

  hasReacted(videoIdOrRecord, reaction = null) {
    try {
      const selected = this.getReaction(videoIdOrRecord);
      if (reaction == null) return selected !== null;
      return selected === normalizeReactionType(reaction);
    } catch { return false; }
  }

  isLiked(videoIdOrRecord) { return this.getReaction(videoIdOrRecord) === "like"; }

  getAllReactionStates(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let states = Array.from(this._states.values());
      if (settings.reactedOnly === true || settings.likedOnly === true || settings.reaction != null) {
        const reaction = settings.likedOnly === true ? "like" : normalizeReactionType(settings.reaction);
        states = states.filter((state) => reaction ? state.reaction === reaction : state.reaction !== null);
      }
      const query = normalizeText(settings.query ?? settings.search, 1024).toLocaleLowerCase();
      if (query) states = states.filter((state) => state.videoId.toLocaleLowerCase().includes(query));
      const sort = normalizeText(settings.sort, 32).toLowerCase();
      states.sort((left, right) => {
        if (sort === "updated-asc") return left.updatedAt - right.updatedAt || left.videoId.localeCompare(right.videoId);
        if (sort === "id-asc") return left.videoId.localeCompare(right.videoId);
        if (sort === "id-desc") return right.videoId.localeCompare(left.videoId);
        return right.updatedAt - left.updatedAt || right.videoId.localeCompare(left.videoId);
      });
      if (settings.limit != null) {
        const limit = Number(settings.limit);
        if (Number.isFinite(limit) && limit >= 0) states = states.slice(0, Math.floor(limit));
      }
      return Object.freeze(states.map(freezeState).filter(Boolean));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getLikedVideos(options = {}) {
    try { return this.getAllReactionStates({ ...options, reaction: "like" }); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getReactedVideos(options = {}) {
    try { return this.getAllReactionStates({ ...options, reactedOnly: true }); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  get count() { return this._states.size; }
  get reactionTypes() { return Object.freeze([...this.allowedReactionTypes]); }

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

  exportData() {
    try { return Object.freeze({ version: 1, videos: this.getAllReactionStates() }); }
    catch (error) { this._reportError(error); return Object.freeze({ version: 1, videos: Object.freeze([]) }); }
  }

  exportJSON(space = 0) {
    try {
      const indentation = Number.isInteger(Number(space)) ? Math.max(0, Math.min(10, Number(space))) : 0;
      return JSON.stringify(this.exportData(), null, indentation);
    } catch (error) { this._reportError(error); return ""; }
  }

  /** Import JSON, an array of states, or {videos|reactions}; replace by default. */
  importReactions(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const settings = isRecord(options) ? options : {};
      let parsed = input;
      if (typeof input === "string") parsed = JSON.parse(input);
      const incoming = Array.isArray(parsed) ? parsed
        : isRecord(parsed) && Array.isArray(parsed.videos) ? parsed.videos
          : isRecord(parsed) && Array.isArray(parsed.reactions) ? parsed.reactions : null;
      if (!incoming) return false;
      const next = settings.replace === false ? new Map(this._states) : new Map();
      for (const candidate of incoming) {
        const state = normalizeState(candidate, this.allowedReactionTypes);
        if (!state) continue;
        if (next.has(state.videoId)) next.delete(state.videoId);
        next.set(state.videoId, state);
      }
      const previousCount = this._states.size;
      this._states = next;
      if (settings.silent !== true) {
        this._persist();
        this._notify("import", null, null, { importedCount: incoming.length, previousCount });
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  importJSON(json, options) { return this.importReactions(json, options); }

  clearAll(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (!this._states.size) return true;
      const previousCount = this._states.size;
      this._states.clear();
      this._persist();
      this._notify("clear-all", null, null, { previousCount });
      if (isRecord(options) && options.removeStorage === true) {
        try { this.storage?.removeItem?.(this.storageKey); } catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      if (isRecord(options) && options.clear === true) this._states.clear();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a reaction manager safely in restricted browser or server environments. */
export function createVideoReactionManager(options = {}) {
  try { return new VideoReactionManager(options); }
  catch { return null; }
}

export { BUILT_IN_REACTIONS };

export default Object.freeze({
  BUILT_IN_REACTIONS,
  VideoReactionManager,
  createVideoReactionManager,
});
