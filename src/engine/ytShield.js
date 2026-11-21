const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const CHANNEL_HANDLE_PATTERN = /^@[A-Za-z0-9._-]{3,30}$/;
const ALLOWED_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const MAX_TRACKED_CLIENTS = 10_000;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.has(host) || host.endsWith(".youtube.com") || host.endsWith(".youtube-nocookie.com");
}

export class YtShield {
  constructor(options = {}) {
    try {
      this.options = options && typeof options === "object" ? options : {};
      this.maxRequests = this.#positiveInteger(this.options.maxRequests, 60);
      this.windowMs = this.#positiveInteger(this.options.windowMs, 60_000);
      this.maxQueryLength = this.#positiveInteger(this.options.maxQueryLength, 200);
      this.allowedChannels = new Set(
        (Array.isArray(this.options.allowedChannels) ? this.options.allowedChannels : [])
          .map((channel) => cleanText(channel, 100))
          .filter(Boolean),
      );
      this.clients = new Map();
    } catch {
      this.options = {};
      this.maxRequests = 60;
      this.windowMs = 60_000;
      this.maxQueryLength = 200;
      this.allowedChannels = new Set();
      this.clients = new Map();
    }
  }

  #positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
  }

  sanitize(value, maxLength = this.maxQueryLength) {
    try {
      const limit = this.#positiveInteger(maxLength, this.maxQueryLength);
      return cleanText(value, limit);
    } catch {
      return "";
    }
  }

  validateVideoId(value) {
    try {
      return VIDEO_ID_PATTERN.test(this.sanitize(value, 128));
    } catch {
      return false;
    }
  }

  validateChannel(value) {
    try {
      const channel = this.sanitize(value, 100);
      if (!channel || !CHANNEL_ID_PATTERN.test(channel) && !CHANNEL_HANDLE_PATTERN.test(channel)) return false;
      return this.allowedChannels.size === 0 || this.allowedChannels.has(channel);
    } catch {
      return false;
    }
  }

  validateUrl(value) {
    try {
      if (typeof value !== "string" || value.length > 2_048) return false;
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || !normalizeHost(url.hostname)) return false;

      if (url.hostname.toLowerCase() === "youtu.be") {
        return this.validateVideoId(url.pathname.split("/").filter(Boolean)[0]);
      }

      if (["youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname.toLowerCase())) {
        return /^\/embed\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname);
      }

      if (url.pathname === "/watch") return this.validateVideoId(url.searchParams.get("v"));
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live") {
        return this.validateVideoId(segments[1]);
      }
      if (segments.length === 1 && (CHANNEL_ID_PATTERN.test(segments[0]) || CHANNEL_HANDLE_PATTERN.test(segments[0]))) {
        return this.validateChannel(segments[0]);
      }
      return false;
    } catch {
      return false;
    }
  }

  isAllowedDomain(value) {
    try {
      const url = value instanceof URL ? value : new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && normalizeHost(url.hostname);
    } catch {
      return false;
    }
  }

  allowRequest(clientKey = "anonymous", now = Date.now()) {
    try {
      const key = this.sanitize(String(clientKey), 128) || "anonymous";
      const timestamp = Number(now);
      if (!Number.isFinite(timestamp)) return false;

      let entry = this.clients.get(key);
      if (!entry || timestamp - entry.startedAt >= this.windowMs || timestamp < entry.startedAt) {
        entry = { startedAt: timestamp, count: 0 };
      }
      if (entry.count >= this.maxRequests) {
        this.clients.set(key, entry);
        return false;
      }

      entry.count += 1;
      this.clients.set(key, entry);
      if (this.clients.size > MAX_TRACKED_CLIENTS) {
        for (const [client, record] of this.clients) {
          if (timestamp - record.startedAt >= this.windowMs || timestamp < record.startedAt) this.clients.delete(client);
        }
        while (this.clients.size > MAX_TRACKED_CLIENTS) this.clients.delete(this.clients.keys().next().value);
      }
      return true;
    } catch {
      return false;
    }
  }

  validateQuery(value) {
    try {
      const query = this.sanitize(value, this.maxQueryLength);
      return query.length > 0 && query.length <= this.maxQueryLength;
    } catch {
      return false;
    }
  }

  sanitizeQuery(value) {
    try {
      return this.sanitize(value, this.maxQueryLength);
    } catch {
      return "";
    }
  }
}

export function createYtShield(options = {}) {
  try {
    return new YtShield(options);
  } catch {
    return new YtShield();
  }
}

export default YtShield;
