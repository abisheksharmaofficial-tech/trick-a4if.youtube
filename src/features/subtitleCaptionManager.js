const STORAGE_KEY = "trick-a4if-tube:subtitle-caption-settings";
const DEFAULT_FONT_SIZE = 24;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 96;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const MIN_OFFSET = -30;
const MAX_OFFSET = 30;
const TIME_EPSILON = 0.000001;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = 512) {
  try { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
  catch { return ""; }
}

function normalizeNumber(value, fallback, min, max) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  } catch { return fallback; }
}

function parseTimestamp(value) {
  try {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== "string") return null;
    const normalized = value.trim().replace(/,(\d{1,3})$/, (_, digits) => `.${digits.padEnd(3, "0")}`);
    const match = normalized.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!match) return null;
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const milliseconds = Number((match[4] ?? "0").padEnd(3, "0"));
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  } catch { return null; }
}

function normalizeCue(input, index = 0) {
  try {
    if (!isRecord(input)) return null;
    const start = parseTimestamp(input.startTime ?? input.start ?? input.from);
    const end = parseTimestamp(input.endTime ?? input.end ?? input.to);
    if (start === null || end === null || end <= start) return null;
    const text = typeof input.text === "string" ? input.text : typeof input.content === "string" ? input.content : "";
    if (!text.trim()) return null;
    const id = normalizeText(input.id, 256) || `cue-${index + 1}`;
    return Object.freeze({ id, startTime: start, endTime: end, text, ...(input.settings ? { settings: normalizeText(input.settings, 512) } : {}) });
  } catch { return null; }
}

function parseSubtitleText(text, format = "auto") {
  try {
    if (typeof text !== "string" || !text.trim()) return [];
    const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
    const cues = [];
    let index = 0;
    while (index < lines.length) {
      let line = lines[index].trim();
      if (!line || /^WEBVTT(?:\s|$)/i.test(line) || /^NOTE(?:\s|$)/i.test(line)
        || /^STYLE(?:\s|$)/i.test(line) || /^REGION(?:\s|$)/i.test(line)) {
        index += 1;
        continue;
      }

      // SRT cue numbers and WebVTT cue identifiers are optional.
      let timingLine = line;
      if (!line.includes("-->")) {
        index += 1;
        if (index >= lines.length || !lines[index].includes("-->")) continue;
        timingLine = lines[index].trim();
      }
      const timing = timingLine.match(/^(.+?)\s+-->\s+(.+?)(?:\s+.*)?$/);
      if (!timing) { index += 1; continue; }
      const startTime = parseTimestamp(timing[1].trim());
      const endToken = timing[2].trim().split(/\s+/)[0];
      const endTime = parseTimestamp(endToken);
      index += 1;
      const body = [];
      while (index < lines.length && lines[index].trim()) {
        body.push(lines[index]);
        index += 1;
      }
      if (startTime !== null && endTime !== null && endTime > startTime && body.length) {
        const cue = normalizeCue({ startTime, endTime, text: body.join("\n") }, cues.length);
        if (cue) cues.push(cue);
      }
      index += 1;
    }
    return cues.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  } catch { return []; }
}

function normalizeCues(cues) {
  try {
    if (!Array.isArray(cues)) return [];
    return cues.map((cue, index) => normalizeCue(cue, index)).filter(Boolean)
      .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  } catch { return []; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeFormat(format, text) {
  try {
    const value = normalizeText(format, 20).toLowerCase();
    if (value === "vtt" || value === "webvtt") return "vtt";
    if (value === "srt" || value === "subrip") return "srt";
    return /^\s*\uFEFF?WEBVTT(?:\s|$)/i.test(text) ? "vtt" : "srt";
  } catch { return "srt"; }
}

/**
 * Manage subtitle tracks and synchronized caption cues. Track inputs may be
 * structured cue arrays or SRT/WebVTT text; no network access is performed.
 */
export class SubtitleCaptionManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.mediaElement = settings.mediaElement ?? settings.videoElement ?? settings.audioElement ?? null;
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onTrackChange = typeof settings.onTrackChange === "function" ? settings.onTrackChange : null;
    this.onCuesChange = typeof settings.onCuesChange === "function" ? settings.onCuesChange : null;
    this.onSettingsChange = typeof settings.onSettingsChange === "function" ? settings.onSettingsChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this.enabled = settings.enabled !== false;
    this.fontSize = DEFAULT_FONT_SIZE;
    this.scale = 1;
    this.offset = 0;
    this.tracks = new Map();
    this.activeTrackId = null;
    this.activeCues = Object.freeze([]);
    this._boundTimeUpdate = () => this.updateFromMediaTime();
    this._boundSeeking = () => this.updateFromMediaTime();
    this._loadSettings();
    this._attachMediaListeners();
    if (Array.isArray(settings.tracks)) {
      for (const track of settings.tracks) this.registerTrack(track);
    }
    if (settings.activeTrackId != null) this.switchTrack(settings.activeTrackId);
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Subtitle caption operation failed.");
      if (this.onError) this.onError(this.lastError, this);
    } catch { /* Error callbacks must not interrupt lifecycle operations. */ }
  }

  _attachMediaListeners() {
    try {
      if (!this.mediaElement || typeof this.mediaElement.addEventListener !== "function") return false;
      this.mediaElement.addEventListener("timeupdate", this._boundTimeUpdate);
      this.mediaElement.addEventListener("seeking", this._boundSeeking);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _loadSettings() {
    try {
      let stored = null;
      try { stored = this.storage?.getItem(this.storageKey); }
      catch (error) { this._reportError(error); }
      if (typeof stored !== "string" || !stored) return false;
      const parsed = JSON.parse(stored);
      if (!isRecord(parsed)) return false;
      this.fontSize = normalizeNumber(parsed.fontSize, DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE);
      this.scale = normalizeNumber(parsed.scale, 1, MIN_SCALE, MAX_SCALE);
      this.offset = normalizeNumber(parsed.offset, 0, MIN_OFFSET, MAX_OFFSET);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _persistSettings() {
    try {
      const settings = { fontSize: this.fontSize, scale: this.scale, offset: this.offset };
      try { this.storage?.setItem(this.storageKey, JSON.stringify(settings)); }
      catch (error) { this._reportError(error); }
      this._emit("settingschange", settings);
      if (this.onSettingsChange) this.onSettingsChange(Object.freeze({ ...settings }), this);
      if (this.onChange) this.onChange({ type: "settings", settings: Object.freeze({ ...settings }) }, this);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _emit(type, detail) {
    try {
      const callback = this[`on${type[0].toUpperCase()}${type.slice(1)}`];
      if (typeof callback === "function") callback(detail, this);
    } catch (error) { this._reportError(error); }
  }

  /** Register a track from {id,label,language,cues} or {id,label,language,text,format}. */
  registerTrack(input, options = {}) {
    try {
      if (this.isDestroyed) return null;
      let definition = input;
      if (typeof input === "string") definition = { ...(isRecord(options) ? options : {}), text: input };
      if (!isRecord(definition)) return null;
      const id = normalizeText(definition.id ?? definition.trackId, 256);
      if (!id) return null;
      const format = normalizeFormat(definition.format, definition.text);
      const cues = Array.isArray(definition.cues)
        ? normalizeCues(definition.cues)
        : parseSubtitleText(definition.text, format);
      const track = Object.freeze({
        id,
        label: normalizeText(definition.label ?? definition.name, 256) || id,
        language: normalizeText(definition.language ?? definition.lang, 64),
        kind: normalizeText(definition.kind, 64) || "subtitles",
        format: Array.isArray(definition.cues) ? "structured" : format,
        cues: Object.freeze(cues),
        metadata: isRecord(definition.metadata) ? Object.freeze({ ...definition.metadata }) : Object.freeze({}),
      });
      this.tracks.set(id, track);
      this._emit("trackregister", track);
      if (this.onChange) this.onChange({ type: "trackregister", track }, this);
      if (definition.enabled === true || definition.active === true) this.switchTrack(id);
      return track;
    } catch (error) { this._reportError(error); return null; }
  }

  addTrack(track, options) { return this.registerTrack(track, options); }

  unregisterTrack(id) {
    try {
      if (this.isDestroyed) return false;
      const trackId = normalizeText(id, 256);
      if (!trackId || !this.tracks.has(trackId)) return false;
      this.tracks.delete(trackId);
      if (this.activeTrackId === trackId) {
        this.activeTrackId = null;
        this.activeCues = Object.freeze([]);
        this._notifyTrackChange(null);
      }
      this._emit("trackremove", { id: trackId });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeTrack(id) { return this.unregisterTrack(id); }

  switchTrack(id) {
    try {
      if (this.isDestroyed) return false;
      const trackId = id == null || id === "" ? null : normalizeText(id, 256);
      if (trackId !== null && !this.tracks.has(trackId)) return false;
      this.activeTrackId = trackId;
      this.activeCues = Object.freeze([]);
      const cues = trackId ? this.getActiveCuesAtTime(Number(this.mediaElement?.currentTime ?? 0)) : [];
      this._setActiveCues(cues, true);
      this._notifyTrackChange(trackId ? this.tracks.get(trackId) : null);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  selectTrack(id) { return this.switchTrack(id); }

  _notifyTrackChange(track) {
    try {
      const detail = Object.freeze({ track, trackId: track?.id ?? null, enabled: this.enabled });
      this._emit("trackchange", detail);
      if (this.onTrackChange) this.onTrackChange(detail, this);
      if (this.onChange) this.onChange({ type: "trackchange", ...detail }, this);
    } catch (error) { this._reportError(error); }
  }

  getTracks() {
    try { return Object.freeze(Array.from(this.tracks.values())); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getActiveTrack() {
    try { return this.activeTrackId ? this.tracks.get(this.activeTrackId) ?? null : null; }
    catch { return null; }
  }

  /** Return cues active at the supplied media time in seconds. */
  getActiveCuesAtTime(seconds) {
    try {
      if (this.isDestroyed || !this.enabled || !this.activeTrackId) return [];
      const time = Number(seconds);
      if (!Number.isFinite(time) || time < 0) return [];
      const track = this.tracks.get(this.activeTrackId);
      if (!track) return [];
      return track.cues.filter((cue) => time + TIME_EPSILON >= cue.startTime && time < cue.endTime - TIME_EPSILON);
    } catch (error) { this._reportError(error); return []; }
  }

  updateFromMediaTime(seconds = this.mediaElement?.currentTime) {
    try {
      if (this.isDestroyed) return [];
      const cues = this.getActiveCuesAtTime(seconds);
      this._setActiveCues(cues);
      return cues;
    } catch (error) { this._reportError(error); return []; }
  }

  _setActiveCues(cues, force = false) {
    try {
      const next = Object.freeze(Array.isArray(cues) ? cues.slice() : []);
      const previousKey = this.activeCues.map((cue) => cue.id).join("\u0000");
      const nextKey = next.map((cue) => cue.id).join("\u0000");
      if (!force && previousKey === nextKey) return false;
      this.activeCues = next;
      const detail = Object.freeze({ cues: next, track: this.getActiveTrack(), trackId: this.activeTrackId });
      this._emit("cueschange", detail);
      if (this.onCuesChange) this.onCuesChange(detail, this);
      if (this.onChange) this.onChange({ type: "cueschange", ...detail }, this);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  enable() {
    try {
      if (this.isDestroyed || this.enabled) return !this.isDestroyed;
      this.enabled = true;
      this.updateFromMediaTime();
      this._emit("enable", { enabled: true });
      if (this.onChange) this.onChange({ type: "enabled", enabled: true }, this);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  disable() {
    try {
      if (this.isDestroyed || !this.enabled) return !this.isDestroyed;
      this.enabled = false;
      this._setActiveCues([]);
      this._emit("disable", { enabled: false });
      if (this.onChange) this.onChange({ type: "enabled", enabled: false }, this);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  toggleEnabled(force) {
    try {
      const enable = typeof force === "boolean" ? force : !this.enabled;
      return enable ? this.enable() : this.disable();
    } catch (error) { this._reportError(error); return false; }
  }

  setEnabled(enabled) { return this.toggleEnabled(Boolean(enabled)); }

  setFontSize(value) {
    try {
      if (this.isDestroyed) return false;
      const size = normalizeNumber(value, NaN, MIN_FONT_SIZE, MAX_FONT_SIZE);
      if (!Number.isFinite(size)) return false;
      this.fontSize = size;
      return this._persistSettings();
    } catch (error) { this._reportError(error); return false; }
  }

  adjustFontSize(delta) {
    try { return this.setFontSize(this.fontSize + Number(delta)); }
    catch (error) { this._reportError(error); return false; }
  }

  setScale(value) {
    try {
      if (this.isDestroyed) return false;
      const scale = normalizeNumber(value, NaN, MIN_SCALE, MAX_SCALE);
      if (!Number.isFinite(scale)) return false;
      this.scale = scale;
      return this._persistSettings();
    } catch (error) { this._reportError(error); return false; }
  }

  adjustScale(delta) {
    try { return this.setScale(this.scale + Number(delta)); }
    catch (error) { this._reportError(error); return false; }
  }

  setOffset(value) {
    try {
      if (this.isDestroyed) return false;
      const offset = normalizeNumber(value, NaN, MIN_OFFSET, MAX_OFFSET);
      if (!Number.isFinite(offset)) return false;
      this.offset = offset;
      return this._persistSettings();
    } catch (error) { this._reportError(error); return false; }
  }

  adjustOffset(delta) {
    try { return this.setOffset(this.offset + Number(delta)); }
    catch (error) { this._reportError(error); return false; }
  }

  getSettings() {
    try {
      return Object.freeze({ enabled: this.enabled, fontSize: this.fontSize, scale: this.scale,
        offset: this.offset, activeTrackId: this.activeTrackId, trackCount: this.tracks.size });
    } catch (error) { this._reportError(error); return null; }
  }

  /** Parse SRT/WebVTT text or pass through an array of cue objects. */
  static parse(textOrCues, format = "auto") {
    try { return Array.isArray(textOrCues) ? normalizeCues(textOrCues) : parseSubtitleText(textOrCues, format); }
    catch { return []; }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.mediaElement?.removeEventListener?.("timeupdate", this._boundTimeUpdate);
      this.mediaElement?.removeEventListener?.("seeking", this._boundSeeking);
      for (const track of this.tracks.values()) {
        // Native TextTrack objects are not owned by this manager and are not disabled or removed.
        void track;
      }
      this.tracks.clear();
      this.activeTrackId = null;
      this.activeCues = Object.freeze([]);
      this.isDestroyed = true;
      this.mediaElement = null;
      this.storage = null;
      this.onChange = null;
      this.onTrackChange = null;
      this.onCuesChange = null;
      this.onSettingsChange = null;
      this.onError = null;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a caption manager without throwing in unsupported environments. */
export function createSubtitleCaptionManager(options = {}) {
  try { return new SubtitleCaptionManager(options); }
  catch { return null; }
}

export { parseSubtitleText };

export default Object.freeze({
  SubtitleCaptionManager,
  createSubtitleCaptionManager,
  parseSubtitleText,
});
