const MAX_ID_LENGTH = 2048;

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, maxLength = MAX_ID_LENGTH) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch {
    return "";
  }
}

function normalizeSeconds(value) {
  try {
    if (value === null || value === undefined || value === "") return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
  } catch {
    return null;
  }
}

function resolveBaseUrl(candidate) {
  try {
    const input = normalizeText(candidate);
    if (input) {
      const parsed = new URL(input);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
      return null;
    }
    const location = globalThis.location;
    if (location?.origin) return new URL(location.origin);
    return null;
  } catch {
    return null;
  }
}

function resolveDocument(candidate) {
  try {
    if (candidate && typeof candidate.createElement === "function") return candidate;
    return typeof globalThis.document !== "undefined" ? globalThis.document : null;
  } catch {
    return null;
  }
}

function normalizeTimestampParameter(value) {
  try {
    const parameter = normalizeText(value, 32);
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(parameter) ? parameter : "t";
  } catch {
    return "t";
  }
}

/**
 * Build share URLs and payloads for caller-provided video, playlist, and
 * channel identifiers. URLs are relative when no site base URL is available.
 */
export class ShareLinkGenerator {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.baseUrl = resolveBaseUrl(settings.baseUrl ?? settings.origin);
    this.videoPath = this._normalizePath(settings.videoPath, "/watch");
    this.playlistPath = this._normalizePath(settings.playlistPath, "/playlist");
    this.channelPath = this._normalizePath(settings.channelPath, "/channel");
    this.videoIdParameter = normalizeText(settings.videoIdParameter, 64) || "v";
    this.playlistIdParameter = normalizeText(settings.playlistIdParameter, 64) || "list";
    this.timestampParameter = normalizeTimestampParameter(settings.timestampParameter);
    this.document = resolveDocument(settings.document);
    this.navigator = this._resolveNavigator(settings.navigator);
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
  }

  /** Build a video watch URL, optionally including a non-negative start time. */
  buildVideoUrl(video, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const videoId = this._identifier(video, ["videoId", "id", "key"]);
      if (!videoId) return "";
      const url = this._createUrl(this.videoPath);
      if (url instanceof URL) {
        url.searchParams.set(this.videoIdParameter, videoId);
        this._addTimestamp(url.searchParams, settings.startSeconds ?? settings.timestamp ?? settings.t);
        return url.toString();
      }
      const params = new URLSearchParams({ [this.videoIdParameter]: videoId });
      this._addTimestamp(params, settings.startSeconds ?? settings.timestamp ?? settings.t);
      return `${this.videoPath}?${params.toString()}`;
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Build a playlist URL, optionally selecting a video and start time. */
  buildPlaylistUrl(playlist, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const playlistId = this._identifier(playlist, ["playlistId", "listId", "id", "key"]);
      if (!playlistId) return "";
      const url = this._createUrl(this.playlistPath);
      const params = url instanceof URL ? url.searchParams : new URLSearchParams();
      params.set(this.playlistIdParameter, playlistId);

      const videoId = this._identifier(settings.videoId ?? settings.video, ["videoId", "id", "key"]);
      if (videoId) params.set(this.videoIdParameter, videoId);
      this._addTimestamp(params, settings.startSeconds ?? settings.timestamp ?? settings.t);

      if (url instanceof URL) return url.toString();
      return `${this.playlistPath}?${params.toString()}`;
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Build a channel URL from a channel identifier or a caller-provided path. */
  buildChannelUrl(channel, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const channelId = this._identifier(channel, ["channelId", "id", "key", "handle"]);
      if (!channelId) return "";
      const path = settings.path === true || channelId.startsWith("@")
        ? `${this.channelPath.replace(/\/$/, "")}/${encodeURIComponent(channelId)}`
        : `${this.channelPath.replace(/\/$/, "")}/${encodeURIComponent(channelId)}`;
      const url = this._createUrl(path);
      return url instanceof URL ? url.toString() : path;
    } catch (error) {
      this._reportError(error);
      return "";
    }
  }

  /** Create the standard title/text/url share payload. */
  buildSharePayload(input = {}, options = {}) {
    try {
      const item = isRecord(input) ? input : {};
      const settings = isRecord(options) ? options : {};
      const url = normalizeText(settings.url ?? item.url)
        || (item.playlistId || item.listId
          ? this.buildPlaylistUrl(item.playlistId ?? item.listId, settings)
          : item.channelId
            ? this.buildChannelUrl(item.channelId, settings)
            : this.buildVideoUrl(item.videoId ?? item.id, {
              ...settings,
              startSeconds: settings.startSeconds ?? item.startSeconds ?? item.timestamp,
            }));
      if (!url) return Object.freeze({ title: "", text: "", url: "" });

      const title = normalizeText(settings.title ?? item.title, 4096);
      const text = normalizeText(settings.text, 8192) || title || url;
      return Object.freeze({ title, text, url });
    } catch (error) {
      this._reportError(error);
      return Object.freeze({ title: "", text: "", url: "" });
    }
  }

  /** Parse a timestamp value (seconds or a time string) to whole seconds. */
  parseTimestamp(value) {
    try {
      if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
        return normalizeSeconds(value);
      }
      const text = normalizeText(value, 64);
      if (!text) return null;
      if (/^\d+(?:\.\d+)?$/.test(text)) return normalizeSeconds(text);

      const parts = text.split(":");
      if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
      const numbers = parts.map(Number);
      if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
      const seconds = numbers.length === 3
        ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
        : numbers[0] * 60 + numbers[1];
      return normalizeSeconds(seconds);
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Parse a video ID and optional t/start-time parameter from a URL. */
  parseVideoUrl(input, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const raw = normalizeText(input);
      if (!raw) return null;
      const url = this._parseUrl(raw);
      const params = url ? url.searchParams : new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "");
      const path = url?.pathname ?? raw.split("?")[0];
      const videoId = params.get(settings.videoIdParameter ?? this.videoIdParameter)
        ?? this._videoIdFromPath(path);
      if (!videoId) return null;
      const timestampRaw = params.get(settings.timestampParameter ?? this.timestampParameter)
        ?? params.get("start")
        ?? params.get("start_seconds");
      return Object.freeze({
        videoId,
        startSeconds: timestampRaw === null ? null : this.parseTimestamp(timestampRaw),
        url: raw,
      });
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  /** Copy URL or payload text using Clipboard API, then a guarded DOM fallback. */
  async copyToClipboard(value, options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      const text = typeof value === "string"
        ? value
        : normalizeText(value?.url) || normalizeText(value?.text);
      if (!text) return false;

      const navigatorObject = this._resolveNavigator(settings.navigator ?? this.navigator);
      try {
        if (navigatorObject?.clipboard && typeof navigatorObject.clipboard.writeText === "function") {
          await navigatorObject.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        this._reportError(error);
      }

      const documentObject = resolveDocument(settings.document ?? this.document);
      if (!documentObject || typeof documentObject.createElement !== "function"
        || typeof documentObject.execCommand !== "function") return false;

      let temporary = null;
      try {
        temporary = documentObject.createElement("textarea");
        temporary.value = text;
        temporary.setAttribute?.("readonly", "");
        temporary.style?.setProperty?.("position", "fixed");
        temporary.style?.setProperty?.("opacity", "0");
        const parent = documentObject.body ?? documentObject.documentElement;
        if (!parent || typeof parent.appendChild !== "function") return false;
        parent.appendChild(temporary);
        temporary.select?.();
        temporary.setSelectionRange?.(0, text.length);
        return Boolean(documentObject.execCommand("copy"));
      } catch (error) {
        this._reportError(error);
        return false;
      } finally {
        try {
          if (temporary?.parentNode) temporary.parentNode.removeChild(temporary);
        } catch { /* Clipboard cleanup is best effort. */ }
      }
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Alias for buildVideoUrl(). */
  videoUrl(video, options) { return this.buildVideoUrl(video, options); }

  /** Alias for buildPlaylistUrl(). */
  playlistUrl(playlist, options) { return this.buildPlaylistUrl(playlist, options); }

  /** Alias for buildChannelUrl(). */
  channelUrl(channel, options) { return this.buildChannelUrl(channel, options); }

  _normalizePath(value, fallback) {
    try {
      const path = normalizeText(value, 1024);
      if (!path) return fallback;
      return path.startsWith("/") ? path : `/${path}`;
    } catch {
      return fallback;
    }
  }

  _identifier(input, keys = []) {
    try {
      if (isRecord(input)) {
        for (const key of keys) {
          const value = normalizeText(input[key], MAX_ID_LENGTH);
          if (value) return value;
        }
        return "";
      }
      return normalizeText(input, MAX_ID_LENGTH);
    } catch {
      return "";
    }
  }

  _createUrl(path) {
    try {
      if (!this.baseUrl) return null;
      return new URL(path, this.baseUrl);
    } catch {
      return null;
    }
  }

  _addTimestamp(params, value) {
    try {
      const seconds = this.parseTimestamp(value);
      if (seconds !== null) params.set(this.timestampParameter, String(seconds));
    } catch (error) {
      this._reportError(error);
    }
  }

  _parseUrl(value) {
    try {
      if (this.baseUrl) return new URL(value, this.baseUrl);
      return new URL(value);
    } catch {
      return null;
    }
  }

  _videoIdFromPath(path) {
    try {
      const parts = String(path ?? "").split("/").filter(Boolean);
      const watchIndex = parts.findIndex((part) => part === "shorts" || part === "embed" || part === "live");
      return watchIndex >= 0 ? decodeURIComponent(parts[watchIndex + 1] ?? "") : "";
    } catch {
      return "";
    }
  }

  _resolveNavigator(candidate) {
    try {
      if (candidate && typeof candidate === "object") return candidate;
      return typeof globalThis.navigator !== "undefined" ? globalThis.navigator : null;
    } catch {
      return null;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Share link generation failed.");
      try { this.onError?.(this.lastError, this); }
      catch { /* Error callbacks must not escape utility operations. */ }
    } catch {
      // Error reporting must never interrupt share URL generation.
    }
  }
}

/** Create a share link generator without throwing in restricted environments. */
export function createShareLinkGenerator(options = {}) {
  try { return new ShareLinkGenerator(options); }
  catch { return null; }
}

export default Object.freeze({
  ShareLinkGenerator,
  createShareLinkGenerator,
});
