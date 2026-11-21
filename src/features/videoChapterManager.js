const STORAGE_KEY = "trick-a4if-tube:video-chapters:v1";
const memoryStorage = new Map();
const MAX_VIDEOS = 10000;
const MAX_CHAPTERS_PER_VIDEO = 10000;
const MAX_TEXT_LENGTH = 4096;

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
    if (isRecord(value)) return normalizeText(value.videoId ?? value.id ?? value.key, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeTime(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "string" && value.includes(":")) {
      const parts = value.trim().split(":");
      if (parts.length !== 2 && parts.length !== 3) return fallback;
      if (!parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) return fallback;
      const numbers = parts.map(Number);
      if (numbers.slice(1).some((part) => part >= 60)) return fallback;
      const seconds = parts.length === 2
        ? numbers[0] * 60 + numbers[1]
        : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
      return Number.isFinite(seconds) && seconds >= 0 ? seconds : fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeLimit(value, fallback = MAX_CHAPTERS_PER_VIDEO) {
  try {
    if (value === Infinity) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(fallback, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function freezeList(items) {
  try { return Object.freeze(items.slice()); }
  catch { return Object.freeze([]); }
}

function parseTimestampLine(line) {
  try {
    if (typeof line !== "string") return null;
    const match = line.trim().match(/^(?:(\d{1,}):(\d{1,2})|(\d{1,}):(\d{1,2}):(\d{1,2}))(?:\.(\d{1,3}))?\s*(?:[-–—:]\s*)?(.+?)?\s*$/);
    if (!match) return null;
    let seconds;
    if (match[3] !== undefined) {
      const hours = Number(match[3]);
      const minutes = Number(match[4]);
      const wholeSeconds = Number(match[5]);
      if (minutes >= 60 || wholeSeconds >= 60) return null;
      seconds = hours * 3600 + minutes * 60 + wholeSeconds;
    } else {
      const minutes = Number(match[1]);
      const wholeSeconds = Number(match[2]);
      if (wholeSeconds >= 60) return null;
      seconds = minutes * 60 + wholeSeconds;
    }
    if (match[6]) seconds += Number(`0.${match[6]}`);
    const title = normalizeText(match[7] ?? "", 2000);
    return title ? { startTime: seconds, title } : null;
  } catch { return null; }
}

function parseChapterInput(input) {
  try {
    if (Array.isArray(input)) return input.filter(isRecord);
    if (typeof input !== "string") return [];
    return input.split(/\r?\n/).map(parseTimestampLine).filter(Boolean);
  } catch { return []; }
}

function normalizeChapter(input, index) {
  try {
    if (!isRecord(input)) return null;
    const startTime = normalizeTime(input.startTime ?? input.start ?? input.timestamp ?? input.time, null);
    if (startTime === null) return null;
    const title = normalizeText(input.title ?? input.name ?? input.label, 2000);
    if (!title) return null;
    const id = normalizeText(input.id ?? input.chapterId, 512) || `chapter-${index}-${startTime}`;
    return { id, title, startTime, endTime: null, duration: 0 };
  } catch { return null; }
}

function normalizeChapters(input, totalDuration = null) {
  try {
    const durationLimit = normalizeTime(totalDuration, null);
    const records = parseChapterInput(input).slice(0, MAX_CHAPTERS_PER_VIDEO);
    const byId = new Map();
    for (let index = 0; index < records.length; index += 1) {
      const chapter = normalizeChapter(records[index], index);
      if (!chapter || (durationLimit !== null && chapter.startTime > durationLimit)) continue;
      byId.set(chapter.id, chapter);
    }
    const sorted = [...byId.values()].sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
    return Object.freeze(sorted.map((chapter, index) => {
      const next = sorted[index + 1];
      let endTime = next ? next.startTime : durationLimit;
      if (durationLimit !== null) endTime = endTime === null ? durationLimit : Math.min(endTime, durationLimit);
      if (endTime !== null && endTime < chapter.startTime) endTime = chapter.startTime;
      const chapterDuration = endTime === null ? 0 : Math.max(0, endTime - chapter.startTime);
      return Object.freeze({ ...chapter, endTime, duration: chapterDuration });
    }));
  } catch { return Object.freeze([]); }
}

function normalizeVideoRecord(input, fallbackId = "") {
  try {
    if (!isRecord(input)) return null;
    const videoId = normalizeId(input.videoId ?? input.id ?? input.key) || fallbackId;
    if (!videoId) return null;
    const totalDuration = normalizeTime(input.totalDuration ?? input.duration ?? input.durationSeconds, null);
    const chapters = normalizeChapters(input.chapters ?? input.text ?? [], totalDuration);
    return Object.freeze({ videoId, totalDuration, chapters });
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

/**
 * Store timestamped chapter lists per video. Times and durations are seconds.
 * Chapters can be supplied as objects or timestamped text lines; no chapters
 * are generated when the caller provides no valid data.
 */
export class VideoChapterManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.videoId = normalizeId(settings.videoId ?? settings.video);
      this.totalDuration = normalizeTime(settings.totalDuration ?? settings.duration, null);
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxVideos = normalizeLimit(settings.maxVideos, MAX_VIDEOS);
      this.maxChaptersPerVideo = normalizeLimit(settings.maxChaptersPerVideo, MAX_CHAPTERS_PER_VIDEO);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._videos = new Map();
      this._listeners = new Set();
      this._load();
      const initial = settings.chapters ?? settings.initialChapters;
      if (this.videoId && initial !== undefined && !this._videos.has(this.videoId)) {
        this.setChapters(this.videoId, initial, { totalDuration: this.totalDuration, silent: true, persist: false });
      }
    } catch (error) {
      this.videoId = "";
      this.totalDuration = null;
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxVideos = MAX_VIDEOS;
      this.maxChaptersPerVideo = MAX_CHAPTERS_PER_VIDEO;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._videos = new Map();
      this._listeners = new Set();
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Video chapter operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callbacks. */ }
    } catch { /* Error handling must not interrupt chapter operations. */ }
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
      const records = Array.isArray(payload) ? payload : payload?.videos;
      if (!Array.isArray(records)) return false;
      this._videos = new Map();
      for (const candidate of records.slice(0, MAX_VIDEOS)) {
        const record = normalizeVideoRecord(candidate);
        if (record) this._videos.set(record.videoId, Object.freeze({ ...record, chapters: freezeList(record.chapters.slice(0, this.maxChaptersPerVideo)) }));
      }
      return true;
    } catch (error) { this._reportError(error); this._videos = new Map(); return false; }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, videos: this.getAllChapters() });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, videoId, chapter = null) {
    try {
      const event = Object.freeze({ type, videoId: videoId ?? null, chapter: chapter ?? null, chapters: videoId ? this.getChapters(videoId) : Object.freeze([]), videos: this.getAllChapters() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _commit(type, videoId, chapter, options = {}) {
    try {
      if (options.persist !== false) this._persist();
      if (options.silent !== true) this._notify(type, videoId, chapter);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _id(videoOrId) { return normalizeId(videoOrId) || this.videoId; }

  _totalDuration(videoId, override) {
    try {
      if (override !== undefined) return normalizeTime(override, null);
      return this._videos.get(videoId)?.totalDuration ?? (videoId === this.videoId ? this.totalDuration : null);
    } catch { return null; }
  }

  /** Replace the chapter list for a video with structured entries or text lines. */
  setChapters(videoOrId, chapters, options = {}) {
    try {
      if (this.isDestroyed || this.maxVideos === 0) return Object.freeze([]);
      const settings = isRecord(options) ? options : {};
      const videoId = this._id(videoOrId);
      if (!videoId) return Object.freeze([]);
      const totalDuration = this._totalDuration(videoId, settings.totalDuration ?? settings.duration);
      const normalized = normalizeChapters(chapters, totalDuration).slice(0, this.maxChaptersPerVideo);
      const record = Object.freeze({ videoId, totalDuration, chapters: freezeList(normalized) });
      this._videos.delete(videoId);
      this._videos.set(videoId, record);
      while (this._videos.size > this.maxVideos) this._videos.delete(this._videos.keys().next().value);
      if (videoId === this.videoId && settings.totalDuration !== undefined) this.totalDuration = totalDuration;
      this._commit("set", videoId, null, settings);
      return record.chapters;
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  setVideoChapters(videoOrId, chapters, options) { return this.setChapters(videoOrId, chapters, options); }
  parseChapters(input, options = {}) {
    try { return normalizeChapters(input, options?.totalDuration ?? options?.duration); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  /** Add a chapter at a timestamp, then recompute neighboring end times. */
  addChapter(videoOrId, input, options = {}) {
    try {
      if (this.isDestroyed) return null;
      const videoId = this._id(videoOrId);
      if (!videoId || !isRecord(input)) return null;
      const current = this._videos.get(videoId);
      const chapter = normalizeChapter(input, current?.chapters.length ?? 0);
      if (!chapter) return null;
      const chapters = [...(current?.chapters ?? []), { ...chapter }];
      const next = this.setChapters(videoId, chapters, { ...(isRecord(options) ? options : {}), totalDuration: options?.totalDuration ?? current?.totalDuration });
      return next.find((item) => item.id === chapter.id) ?? null;
    } catch (error) { this._reportError(error); return null; }
  }

  add(videoOrId, chapter, options) { return this.addChapter(videoOrId, chapter, options); }

  updateChapter(videoOrId, chapterId, changes, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(changes)) return null;
      const videoId = this._id(videoOrId);
      const record = this._videos.get(videoId);
      const id = normalizeText(chapterId, 512);
      if (!record || !id) return null;
      const index = record.chapters.findIndex((chapter) => chapter.id === id);
      if (index < 0) return null;
      const chapters = record.chapters.map((chapter, currentIndex) => currentIndex === index ? { ...chapter, ...changes, id } : chapter);
      const updated = this.setChapters(videoId, chapters, { ...(isRecord(options) ? options : {}), totalDuration: options?.totalDuration ?? record.totalDuration });
      return updated.find((chapter) => chapter.id === id) ?? null;
    } catch (error) { this._reportError(error); return null; }
  }

  update(videoOrId, chapterId, changes, options) { return this.updateChapter(videoOrId, chapterId, changes, options); }

  removeChapter(videoOrId, chapterId, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const videoId = this._id(videoOrId);
      const record = this._videos.get(videoId);
      const id = normalizeText(chapterId, 512);
      if (!record || !id || !record.chapters.some((chapter) => chapter.id === id)) return false;
      const chapters = record.chapters.filter((chapter) => chapter.id !== id);
      this.setChapters(videoId, chapters, { ...(isRecord(options) ? options : {}), totalDuration: record.totalDuration });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  remove(videoOrId, chapterId, options) { return this.removeChapter(videoOrId, chapterId, options); }

  clearVideo(videoOrId, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const videoId = this._id(videoOrId);
      if (!videoId || !this._videos.has(videoId)) return false;
      this._videos.delete(videoId);
      this._commit("cleared", videoId, null, isRecord(options) ? options : {});
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getChapters(videoOrId = this.videoId, options = {}) {
    try {
      const videoId = this._id(videoOrId);
      const record = this._videos.get(videoId);
      if (!record) return Object.freeze([]);
      let chapters = record.chapters.slice();
      const query = normalizeText(typeof options === "string" ? options : options?.search ?? options?.query, 1000).toLocaleLowerCase();
      if (query) chapters = chapters.filter((chapter) => [chapter.id, chapter.title].some((value) => value.toLocaleLowerCase().includes(query)));
      const order = isRecord(options) && (options.order === "desc" || options.ascending === false) ? -1 : 1;
      chapters.sort((left, right) => order * (left.startTime - right.startTime));
      if (isRecord(options) && options.limit !== undefined) chapters = chapters.slice(0, normalizeLimit(options.limit, MAX_CHAPTERS_PER_VIDEO));
      return freezeList(chapters);
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  list(videoOrId, options) { return this.getChapters(videoOrId, options); }
  search(query, options = {}) {
    try { return this.getChapters(options.videoId ?? this.videoId, { ...((isRecord(options)) ? options : {}), search: query }); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getChapter(videoOrId, chapterId) {
    try {
      const id = normalizeText(chapterId, 512);
      return this.getChapters(videoOrId).find((chapter) => chapter.id === id) ?? null;
    } catch { return null; }
  }

  /** Return active chapter with clamped progress ratio, or null outside chapters. */
  getActiveChapter(videoOrId, currentTime, options = {}) {
    try {
      const videoId = this._id(videoOrId);
      const time = normalizeTime(currentTime, null);
      if (time === null) return null;
      const chapters = this.getChapters(videoId);
      if (!chapters.length || time < chapters[0].startTime) return null;
      let activeIndex = -1;
      for (let index = 0; index < chapters.length; index += 1) {
        if (chapters[index].startTime <= time) activeIndex = index;
        else break;
      }
      if (activeIndex < 0) return null;
      const chapter = chapters[activeIndex];
      const duration = chapter.endTime === null
        ? normalizeTime(options?.totalDuration, this._totalDuration(videoId) ?? 0) - chapter.startTime
        : chapter.duration;
      const progressRatio = duration > 0 ? Math.min(1, Math.max(0, (time - chapter.startTime) / duration)) : 0;
      return Object.freeze({ ...chapter, progressRatio, index: activeIndex });
    } catch (error) { this._reportError(error); return null; }
  }

  getActive(videoOrId, currentTime, options) { return this.getActiveChapter(videoOrId, currentTime, options); }
  resolveActiveChapter(videoOrId, currentTime, options) { return this.getActiveChapter(videoOrId, currentTime, options); }

  getNextChapter(videoOrId, currentTime, options = {}) {
    try {
      const time = normalizeTime(currentTime, null);
      if (time === null) return null;
      return this.getChapters(videoOrId).find((chapter) => options.inclusive === true ? chapter.startTime >= time : chapter.startTime > time) ?? null;
    } catch (error) { this._reportError(error); return null; }
  }

  getPreviousChapter(videoOrId, currentTime, options = {}) {
    try {
      const time = normalizeTime(currentTime, null);
      if (time === null) return null;
      const chapters = this.getChapters(videoOrId);
      for (let index = chapters.length - 1; index >= 0; index -= 1) {
        if (options.inclusive === true ? chapters[index].startTime <= time : chapters[index].startTime < time) return chapters[index];
      }
      return null;
    } catch (error) { this._reportError(error); return null; }
  }

  next(videoOrId, currentTime, options) { return this.getNextChapter(videoOrId, currentTime, options); }
  previous(videoOrId, currentTime, options) { return this.getPreviousChapter(videoOrId, currentTime, options); }

  getAllChapters(options = {}) {
    try {
      const records = [...this._videos.values()];
      const settings = isRecord(options) ? options : {};
      const query = normalizeText(settings.search ?? settings.query, 1000).toLocaleLowerCase();
      let result = records.map((record) => ({ videoId: record.videoId, totalDuration: record.totalDuration, chapters: record.chapters }));
      if (query) result = result.map((record) => ({ ...record, chapters: record.chapters.filter((chapter) => chapter.title.toLocaleLowerCase().includes(query)) })).filter((record) => record.chapters.length);
      return Object.freeze(result.map((record) => Object.freeze(record)));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getVideoCount() { try { return this._videos.size; } catch { return 0; } }
  get size() { return this.getVideoCount(); }

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
      const payload = { version: 1, exportedAt: Date.now(), videos: this.getAllChapters() };
      return settings.asObject === true ? Object.freeze(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { videos: payload };
      const records = isRecord(payload) ? payload.videos ?? payload.entries : null;
      if (!Array.isArray(records)) return 0;
      const next = settings.replace === true ? new Map() : new Map(this._videos);
      let imported = 0;
      for (const candidate of records.slice(0, MAX_VIDEOS)) {
        const video = normalizeVideoRecord(candidate);
        if (!video) continue;
        next.set(video.videoId, Object.freeze({ ...video, chapters: freezeList(video.chapters.slice(0, this.maxChaptersPerVideo)) }));
        imported += 1;
      }
      this._videos = next;
      while (this._videos.size > this.maxVideos) this._videos.delete(this._videos.keys().next().value);
      if (settings.silent !== true) this._commit("imported", null, null, settings);
      else if (settings.persist !== false) this._persist();
      return imported;
    } catch (error) { this._reportError(error); return 0; }
  }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      if (isRecord(options) && options.clear === true) this._videos.clear();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a chapter manager safely in browser, server, or restricted-storage environments. */
export function createVideoChapterManager(options = {}) {
  try { return new VideoChapterManager(options); }
  catch { return null; }
}

export default Object.freeze({ VideoChapterManager, createVideoChapterManager });
