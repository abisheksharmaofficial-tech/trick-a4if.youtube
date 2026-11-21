const STORAGE_KEY = "trick-a4if-tube:channel-profile-aggregator:v1";
const memoryStorage = new Map();
const MAX_CHANNELS = 10000;
const MAX_VIDEOS_PER_CHANNEL = 10000;
const MAX_TEXT_LENGTH = 4096;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

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

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.channelId ?? value.id ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function nonNegative(value, fallback = 0) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number > 0 && number < 100000000000 ? number * 1000 : number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
}

function cloneJSON(value, fallback = null) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? JSON.parse(serialized) : fallback;
  } catch { return fallback; }
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

function normalizeVideo(input) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeText(input.id ?? input.videoId ?? input.key, 512);
    if (!id) return null;
    return freezeDeep({
      ...cloneJSON(input, {}),
      id,
      title: normalizeText(input.title ?? input.name, 2000),
      category: normalizeText(input.category ?? input.categoryName ?? input.topic, 512),
      views: nonNegative(input.views ?? input.viewCount ?? input.viewsCount, 0),
      likes: nonNegative(input.likes ?? input.likeCount, 0),
      publishedAt: normalizeTimestamp(input.publishedAt ?? input.publishedAtTimestamp ?? input.createdAt ?? input.timestamp, 0),
    });
  } catch { return null; }
}

function normalizeMetadata(input, id) {
  try {
    const source = isRecord(input) ? cloneJSON(input, {}) : {};
    return freezeDeep({
      ...source,
      id,
      name: normalizeText(source.name ?? source.title ?? source.channelName, 2000),
      handle: normalizeText(source.handle ?? source.username, 512),
      description: normalizeText(source.description ?? source.about, 10000),
      avatar: normalizeText(source.avatar ?? source.avatarUrl ?? source.thumbnail, 8192),
      banner: normalizeText(source.banner ?? source.bannerUrl, 8192),
      category: normalizeText(source.category, 512),
      subscriberCount: nonNegative(source.subscriberCount ?? source.subscribers, 0),
      url: normalizeText(source.url ?? source.channelUrl, 4096),
    });
  } catch { return freezeDeep({ id, name: "", handle: "", description: "", avatar: "", banner: "", category: "", subscriberCount: 0, url: "" }); }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeLimit(value, fallback = MAX_CHANNELS) {
  try {
    if (value === Infinity) return MAX_CHANNELS;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_CHANNELS, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function normalizeProfile(input, now = Date.now(), subscriptions = null) {
  try {
    if (!isRecord(input)) return null;
    const channelInput = isRecord(input.metadata) ? input.metadata : isRecord(input.channel) ? input.channel : input;
    const id = normalizeId(input.channelId ?? input.id ?? input.key ?? channelInput);
    if (!id) return null;
    const rawVideos = Array.isArray(input.videos) ? input.videos : [];
    const byId = new Map();
    for (const candidate of rawVideos.slice(0, MAX_VIDEOS_PER_CHANNEL)) {
      const video = normalizeVideo(candidate);
      if (video) byId.set(video.id, video);
    }
    const videos = [...byId.values()];
    const totalViews = videos.reduce((sum, video) => sum + video.views, 0);
    const totalLikes = videos.reduce((sum, video) => sum + video.likes, 0);
    const categories = new Map();
    for (const video of videos) {
      const category = normalizeText(video.category, 512);
      if (!category) continue;
      const current = categories.get(category) ?? { category, videoCount: 0, views: 0 };
      current.videoCount += 1;
      current.views += video.views;
      categories.set(category, current);
    }
    const topCategories = [...categories.values()]
      .sort((left, right) => right.videoCount - left.videoCount || right.views - left.views || left.category.localeCompare(right.category))
      .slice(0, 10)
      .map((item) => Object.freeze(item));
    const subscribedValue = input.isSubscribed ?? input.subscribed ?? input.subscriptionStatus;
    const override = input.subscriptionOverride;
    const isSubscribed = typeof override === "boolean" ? override
      : typeof subscribedValue === "boolean" ? subscribedValue
        : typeof subscriptions?.isSubscribed === "function" ? Boolean(subscriptions.isSubscribed(id))
          : false;
    return freezeDeep({
      id,
      channelId: id,
      metadata: normalizeMetadata(channelInput, id),
      videos: Object.freeze(videos),
      metrics: Object.freeze({
        videoCount: videos.length,
        totalViews,
        totalLikes,
        averageViews: videos.length ? totalViews / videos.length : 0,
        topCategories: Object.freeze(topCategories),
      }),
      isSubscribed,
      subscriptionOverride: typeof override === "boolean" ? override : null,
      cachedAt: normalizeTimestamp(input.cachedAt, now),
    });
  } catch { return null; }
}

function matchesQuery(profile, query) {
  try {
    const q = normalizeText(query, 1024).toLocaleLowerCase();
    if (!q) return true;
    const fields = [profile.id, profile.metadata.name, profile.metadata.handle, profile.metadata.description, profile.metadata.category];
    return fields.some((value) => value.toLocaleLowerCase().includes(q))
      || profile.videos.some((video) => [video.id, video.title, video.category].some((value) => value.toLocaleLowerCase().includes(q)));
  } catch { return false; }
}

/**
 * Aggregate caller-supplied channel and video data into cached local profiles.
 * No network requests or placeholder data are generated. Subscription state can
 * be read from a compatible manager and overridden per profile.
 */
export class ChannelProfileAggregator {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.cacheTtlMs = nonNegative(settings.cacheTtlMs ?? settings.ttlMs, DEFAULT_CACHE_TTL_MS);
      this.maxChannels = normalizeLimit(settings.maxChannels, MAX_CHANNELS);
      this.subscriptionManager = settings.subscriptionManager ?? settings.subscriptions ?? null;
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._profiles = new Map();
      this._listeners = new Set();
      this._load();
      const initialProfiles = settings.profiles ?? settings.channels;
      if (Array.isArray(initialProfiles) && this._profiles.size === 0) {
        for (const profile of initialProfiles) this.aggregate(profile, { silent: true, persist: false });
      }
    } catch (error) {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
      this.maxChannels = MAX_CHANNELS;
      this.subscriptionManager = null;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._profiles = new Map();
      this._listeners = new Set();
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Channel profile operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callbacks. */ }
    } catch { /* Error handling must not interrupt aggregation. */ }
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
      const records = Array.isArray(payload) ? payload : payload?.profiles;
      if (!Array.isArray(records)) return false;
      this._profiles = new Map();
      for (const entry of records) {
        const profile = normalizeProfile(entry, Date.now(), this.subscriptionManager);
        if (profile) this._profiles.set(profile.id, profile);
      }
      this._enforceLimit();
      return true;
    } catch (error) { this._reportError(error); this._profiles = new Map(); return false; }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, profiles: this.getProfiles() });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _enforceLimit() {
    try {
      while (this._profiles.size > this.maxChannels) this._profiles.delete(this._profiles.keys().next().value);
    } catch (error) { this._reportError(error); }
  }

  _notify(type, channelId, profile = null) {
    try {
      const event = Object.freeze({ type, channelId: channelId ?? null, profile: profile ?? null, profiles: this.getProfiles(), count: this._profiles.size });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _commit(type, id, profile, options = {}) {
    try {
      if (options.persist !== false) this._persist();
      if (options.silent !== true) this._notify(type, id, profile);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Normalize channel metadata and aggregate the provided video list. */
  aggregate(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxChannels === 0 || !isRecord(input)) return null;
      const settings = isRecord(options) ? options : {};
      const id = normalizeId(input.channelId ?? input.id ?? input.key ?? input.metadata ?? input.channel);
      if (!id) return null;
      const prior = this._profiles.get(id);
      const source = { ...(prior ?? {}), ...input, id, channelId: id };
      if (input.metadata === undefined && prior) source.metadata = { ...prior.metadata, ...input };
      const profile = normalizeProfile({ ...source, subscriptionOverride: settings.subscriptionOverride ?? source.subscriptionOverride, cachedAt: settings.cachedAt ?? Date.now() }, Date.now(), this.subscriptionManager);
      if (!profile) return null;
      this._profiles.delete(id);
      this._profiles.set(id, profile);
      this._enforceLimit();
      this._commit(prior ? "updated" : "aggregated", id, profile, settings);
      return profile;
    } catch (error) { this._reportError(error); return null; }
  }

  setProfile(input, options = {}) { return this.aggregate(input, options); }
  updateChannel(input, options = {}) { return this.aggregate(input, options); }

  /** Refresh from explicitly provided data or an optional caller-provided loader. */
  refresh(channelOrId, dataOrOptions = {}) {
    try {
      if (this.isDestroyed) return null;
      const id = normalizeId(channelOrId);
      if (isRecord(channelOrId)) {
        const settings = isRecord(dataOrOptions) ? dataOrOptions : {};
        return this.aggregate({ ...channelOrId, ...(isRecord(settings.data) ? settings.data : {}) }, { ...settings, refresh: true });
      }
      if (!id) return null;
      const settings = isRecord(dataOrOptions) ? dataOrOptions : {};
      if (isRecord(settings.data)) return this.aggregate({ ...settings.data, id, channelId: id }, { ...settings, refresh: true });
      const loader = settings.loader ?? settings.fetchProfile;
      if (typeof loader === "function") {
        let result;
        try { result = loader(id); } catch (error) { this._reportError(error); return null; }
        if (result && typeof result.then === "function") {
          return result.then((data) => this.aggregate({ ...(isRecord(data) ? data : {}), id, channelId: id }, { ...settings, refresh: true }))
            .catch((error) => { this._reportError(error); return null; });
        }
        return this.aggregate({ ...(isRecord(result) ? result : {}), id, channelId: id }, { ...settings, refresh: true });
      }
      const existing = this._profiles.get(id);
      if (!existing) return null;
      const refreshed = normalizeProfile({ ...existing, cachedAt: Date.now() }, Date.now(), this.subscriptionManager);
      this._profiles.set(id, refreshed);
      this._commit("refreshed", id, refreshed, settings);
      return refreshed;
    } catch (error) { this._reportError(error); return null; }
  }

  refreshChannel(channelOrId, options) { return this.refresh(channelOrId, options); }

  getProfile(channelOrId, options = {}) {
    try {
      const id = normalizeId(channelOrId);
      if (!id || this.isDestroyed) return null;
      const settings = isRecord(options) ? options : {};
      const profile = this._profiles.get(id);
      if (!profile) return null;
      const now = normalizeTimestamp(settings.now, Date.now());
      const ttl = nonNegative(settings.cacheTtlMs ?? settings.ttlMs, this.cacheTtlMs);
      if (settings.allowStale !== true && ttl > 0 && now - profile.cachedAt > ttl) return null;
      const override = settings.subscriptionOverride;
      if (typeof override === "boolean") return normalizeProfile({ ...profile, subscriptionOverride: override }, now, this.subscriptionManager);
      if (this.subscriptionManager && typeof this.subscriptionManager.isSubscribed === "function") {
        return normalizeProfile({ ...profile, subscriptionOverride: profile.subscriptionOverride, isSubscribed: undefined }, now, this.subscriptionManager);
      }
      return profile;
    } catch (error) { this._reportError(error); return null; }
  }

  get(channelOrId, options) { return this.getProfile(channelOrId, options); }
  getCachedProfile(channelOrId) { return this.getProfile(channelOrId, { allowStale: true }); }

  setSubscriptionStatus(channelOrId, subscribed, options = {}) {
    try {
      if (this.isDestroyed || typeof subscribed !== "boolean") return null;
      const id = normalizeId(channelOrId);
      const previous = this._profiles.get(id);
      if (!id || !previous) return null;
      const settings = isRecord(options) ? options : {};
      const profile = normalizeProfile({ ...previous, isSubscribed: subscribed, subscriptionOverride: subscribed, cachedAt: Date.now() }, Date.now(), this.subscriptionManager);
      this._profiles.set(id, profile);
      this._commit("subscription-updated", id, profile, settings);
      return profile;
    } catch (error) { this._reportError(error); return null; }
  }

  clearSubscriptionOverride(channelOrId, options = {}) {
    try {
      if (this.isDestroyed) return null;
      const id = normalizeId(channelOrId);
      const previous = this._profiles.get(id);
      if (!id || !previous) return null;
      const profile = normalizeProfile({ ...previous, subscriptionOverride: null, isSubscribed: undefined, cachedAt: Date.now() }, Date.now(), this.subscriptionManager);
      this._profiles.set(id, profile);
      this._commit("subscription-override-cleared", id, profile, isRecord(options) ? options : {});
      return profile;
    } catch (error) { this._reportError(error); return null; }
  }

  invalidate(channelOrId, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const id = normalizeId(channelOrId);
      const settings = isRecord(options) ? options : {};
      if (settings.all === true || channelOrId == null) {
        if (!this._profiles.size) return true;
        this._profiles.clear();
        this._commit("invalidated-all", null, null, settings);
        return true;
      }
      if (!id || !this._profiles.has(id)) return false;
      this._profiles.delete(id);
      this._commit("invalidated", id, null, settings);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  invalidateCache(channelOrId, options) { return this.invalidate(channelOrId, options); }

  getProfiles(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let profiles = [...this._profiles.values()];
      const query = normalizeText(settings.query ?? settings.search, 1024);
      if (query) profiles = profiles.filter((profile) => matchesQuery(profile, query));
      const category = normalizeText(settings.category, 512).toLocaleLowerCase();
      if (category) profiles = profiles.filter((profile) => profile.metadata.category.toLocaleLowerCase() === category
        || profile.metrics.topCategories.some((item) => item.category.toLocaleLowerCase() === category));
      if (typeof settings.subscribed === "boolean") profiles = profiles.filter((profile) => this.getProfile(profile.id, { allowStale: settings.allowStale === true })?.isSubscribed === settings.subscribed);
      const sortBy = normalizeText(settings.sortBy ?? settings.sort, 32);
      if (sortBy === "views" || sortBy === "totalViews") profiles.sort((a, b) => b.metrics.totalViews - a.metrics.totalViews || a.id.localeCompare(b.id));
      else if (sortBy === "subscribers" || sortBy === "subscriberCount") profiles.sort((a, b) => b.metadata.subscriberCount - a.metadata.subscriberCount || a.id.localeCompare(b.id));
      else if (sortBy === "name") profiles.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name) || a.id.localeCompare(b.id));
      else profiles.sort((a, b) => b.cachedAt - a.cachedAt || a.id.localeCompare(b.id));
      const offset = normalizeLimit(settings.offset ?? 0, 0);
      const limit = settings.limit === undefined ? profiles.length : normalizeLimit(settings.limit, 0);
      return Object.freeze(profiles.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  query(options = {}) { return this.getProfiles(options); }
  search(query, options = {}) {
    try { return this.getProfiles({ ...(isRecord(options) ? options : {}), query }); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
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
      const payload = { version: 1, exportedAt: Date.now(), profiles: this.getProfiles({ allowStale: true }) };
      return settings.asObject === true ? freezeDeep(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { profiles: payload };
      const records = isRecord(payload) ? payload.profiles ?? payload.channels : null;
      if (!Array.isArray(records)) return 0;
      const next = settings.replace === true ? new Map() : new Map(this._profiles);
      let imported = 0;
      for (const candidate of records.slice(0, MAX_CHANNELS)) {
        const profile = normalizeProfile(candidate, Date.now(), this.subscriptionManager);
        if (!profile) continue;
        next.set(profile.id, profile);
        imported += 1;
      }
      this._profiles = next;
      this._enforceLimit();
      this._commit("imported", null, null, settings);
      return imported;
    } catch (error) { this._reportError(error); return 0; }
  }

  get size() { try { return this._profiles.size; } catch { return 0; } }
  get count() { return this.size; }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      if (isRecord(options) && options.clear === true) this._profiles.clear();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.subscriptionManager = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Safely create a channel profile aggregator in browser or server contexts. */
export function createChannelProfileAggregator(options = {}) {
  try { return new ChannelProfileAggregator(options); }
  catch { return null; }
}

export default Object.freeze({ ChannelProfileAggregator, createChannelProfileAggregator });
