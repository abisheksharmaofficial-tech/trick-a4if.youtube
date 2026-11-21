/**
 * Browser voice-command control built on the Web Speech API.
 *
 * Recognition is performed by the browser. This module does not request
 * microphone permission itself, store transcripts, or transmit command data.
 * The caller should explain browser permission and privacy behavior to users.
 */

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_COOLDOWN_MS = 700;
const DEFAULT_VOLUME_STEP = 0.1;
const DEFAULT_SEEK_SECONDS = 10;

const COMMAND_PATTERNS = Object.freeze([
  { command: "volumeUp", patterns: [/\b(?:volume\s+up|increase\s+(?:the\s+)?volume|louder)\b/] },
  { command: "volumeDown", patterns: [/\b(?:volume\s+down|decrease\s+(?:the\s+)?volume|quieter|softer)\b/] },
  { command: "seekForward", patterns: [/\b(?:seek|skip|forward)\s+(?:forward\s+)?(?:\d+(?:\.\d+)?\s+)?(?:seconds?|secs?|minutes?|mins?)?\b/, /\bfast\s+forward\b/] },
  { command: "seekBackward", patterns: [/\b(?:seek|skip|go)\s+back(?:ward)?\s+(?:\d+(?:\.\d+)?\s+)?(?:seconds?|secs?|minutes?|mins?)?\b/, /\brewind\b/] },
  { command: "unmute", patterns: [/\b(?:unmute|turn\s+(?:the\s+)?sound\s+on)\b/] },
  { command: "mute", patterns: [/\b(?:mute|silence|turn\s+(?:the\s+)?sound\s+off)\b/] },
  { command: "next", patterns: [/\b(?:next|skip\s+to\s+next)\b/] },
  { command: "previous", patterns: [/\b(?:previous|prev|go\s+back|last\s+video)\b/] },
  { command: "toggle", patterns: [/\b(?:toggle|play\s*\/\s*pause)\b/] },
  { command: "pause", patterns: [/\b(?:pause|stop\s+playback)\b/] },
  { command: "play", patterns: [/\b(?:play|resume|continue)\b/] },
]);

function asOptions(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, number))
    : fallback;
}

function normalizeTranscript(value) {
  try {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s'’.-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function getRecognitionConstructor(settings) {
  try {
    if (typeof settings.SpeechRecognition === "function") return settings.SpeechRecognition;
    if (typeof settings.recognitionConstructor === "function") return settings.recognitionConstructor;
    if (typeof globalThis !== "undefined") {
      return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function parseDuration(transcript, fallbackSeconds) {
  try {
    const match = transcript.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b/);
    if (!match) return fallbackSeconds;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return fallbackSeconds;
    return Math.min(3600, amount * (/^m/i.test(match[2]) ? 60 : 1));
  } catch {
    return fallbackSeconds;
  }
}

function extractSearchQuery(transcript) {
  try {
    const match = transcript.match(/\b(?:search(?:\s+for)?|find)\s+(.+)$/i);
    return match && match[1] ? match[1].trim().replace(/[.!?]+$/, "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Match a recognized transcript to one supported command.
 * Returns null when no command is present. Search commands include their query.
 */
export function matchVoiceCommand(transcript) {
  try {
    const normalized = normalizeTranscript(transcript);
    if (!normalized) return null;

    const query = extractSearchQuery(normalized);
    if (query) return Object.freeze({ command: "search", query, transcript: normalized });

    for (const entry of COMMAND_PATTERNS) {
      if (entry.patterns.some((pattern) => pattern.test(normalized))) {
        const result = { command: entry.command, transcript: normalized };
        if (entry.command === "seekForward" || entry.command === "seekBackward") {
          result.seconds = parseDuration(normalized, DEFAULT_SEEK_SECONDS);
        }
        return Object.freeze(result);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Listen for spoken media commands. Commands are delivered via onCommand and,
 * when a mediaElement is supplied, common playback controls are applied locally.
 */
export class VoiceCommandControl {
  constructor(options = {}) {
    const settings = asOptions(options);
    this.language = typeof settings.language === "string" && settings.language.trim()
      ? settings.language.trim()
      : DEFAULT_LANGUAGE;
    this.continuous = settings.continuous !== false;
    this.interimResults = settings.interimResults !== false;
    this.processInterim = settings.processInterim === true;
    this.debounceMs = boundedNumber(settings.debounceMs, DEFAULT_DEBOUNCE_MS, 0, 10000);
    this.cooldownMs = boundedNumber(settings.cooldownMs, DEFAULT_COOLDOWN_MS, 0, 30000);
    this.volumeStep = boundedNumber(settings.volumeStep, DEFAULT_VOLUME_STEP, 0.01, 1);
    this.seekSeconds = boundedNumber(settings.seekSeconds, DEFAULT_SEEK_SECONDS, 1, 3600);
    this.mediaElement = settings.mediaElement ?? settings.videoElement ?? settings.audioElement ?? null;
    this.onCommand = typeof settings.onCommand === "function" ? settings.onCommand : null;
    this.onTranscript = typeof settings.onTranscript === "function" ? settings.onTranscript : null;
    this.onStatus = typeof settings.onStatus === "function" ? settings.onStatus : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;

    this.isSupported = false;
    this.isRunning = false;
    this.isDestroyed = false;
    this.lastError = null;
    this.lastCommand = null;
    this.lastCommandAt = 0;
    this.recognition = null;
    this._lastTranscript = "";
    this._lastTranscriptAt = 0;
    this._startRequested = false;
    this._stopRequested = false;
    this._handlers = null;

    try {
      if (settings.recognition && typeof settings.recognition.start === "function") {
        this.recognition = settings.recognition;
      } else {
        const Recognition = getRecognitionConstructor(settings);
        if (Recognition) this.recognition = new Recognition();
      }

      if (!this.recognition) return;
      this.isSupported = true;
      this._configureRecognition();
    } catch (error) {
      this._reportError(error);
      this.recognition = null;
      this.isSupported = false;
    }
  }

  /** Start speech recognition. Returns false if unsupported or unavailable. */
  start() {
    try {
      if (this.isDestroyed || !this.isSupported || !this.recognition) return false;
      if (this.isRunning || this._startRequested) return true;

      this._stopRequested = false;
      this._startRequested = true;
      this.recognition.start();
      this.isRunning = true;
      this._notifyStatus("listening");
      return true;
    } catch (error) {
      this._startRequested = false;
      this.isRunning = false;
      this._reportError(error);
      return false;
    }
  }

  /** Stop recognition without discarding callbacks or configuration. */
  stop() {
    try {
      if (this.isDestroyed) return false;
      this._stopRequested = true;
      this._startRequested = false;
      if (!this.recognition) {
        this.isRunning = false;
        return true;
      }

      if (this.isRunning && typeof this.recognition.stop === "function") {
        this.recognition.stop();
      } else if (typeof this.recognition.abort === "function") {
        this.recognition.abort();
      }
      this.isRunning = false;
      this._notifyStatus("stopped");
      return true;
    } catch (error) {
      this.isRunning = false;
      this._reportError(error);
      return false;
    }
  }

  /** Stop recognition and detach handlers and user callbacks. */
  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.stop();
      if (this.recognition && this._handlers) {
        for (const [name, handler] of Object.entries(this._handlers)) {
          if (this.recognition[`on${name}`] === handler) this.recognition[`on${name}`] = null;
        }
      }
      this._handlers = null;
      this.recognition = null;
      this.mediaElement = null;
      this.onCommand = null;
      this.onTranscript = null;
      this.onStatus = null;
      this.onError = null;
      this.isSupported = false;
      this.isRunning = false;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }

  /** Match and dispatch a transcript directly, useful for caller-owned input. */
  handleTranscript(transcript, options = {}) {
    try {
      if (this.isDestroyed) return null;
      const settings = asOptions(options);
      const text = String(transcript ?? "").trim();
      const isFinal = settings.isFinal !== false;
      this._notifyTranscript(text, isFinal);
      if (!isFinal && !this.processInterim) return null;
      if (!text) return null;

      const now = Number.isFinite(Number(settings.timestamp)) ? Number(settings.timestamp) : Date.now();
      const normalized = normalizeTranscript(text);
      if (!normalized) return null;
      if (normalized === this._lastTranscript && now - this._lastTranscriptAt < this.debounceMs) return null;
      this._lastTranscript = normalized;
      this._lastTranscriptAt = now;

      const match = matchVoiceCommand(normalized);
      if (!match) return null;
      if (match.command === this.lastCommand && now - this.lastCommandAt < this.cooldownMs) return null;

      this.lastCommand = match.command;
      this.lastCommandAt = now;
      const command = Object.freeze({ ...match, timestamp: now, isFinal });
      this._applyMediaCommand(command);
      this._notifyCommand(command);
      return command;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _configureRecognition() {
    try {
      const recognition = this.recognition;
      recognition.lang = this.language;
      recognition.continuous = this.continuous;
      recognition.interimResults = this.interimResults;
      this._handlers = {
        result: (event) => this._handleResult(event),
        error: (event) => this._handleRecognitionError(event),
        end: () => this._handleEnd(),
        start: () => {
          if (!this.isDestroyed) {
            this.isRunning = true;
            this._notifyStatus("listening");
          }
        },
      };
      for (const [name, handler] of Object.entries(this._handlers)) {
        recognition[`on${name}`] = handler;
      }
    } catch (error) {
      this._reportError(error);
      this.isSupported = false;
    }
  }

  _handleResult(event) {
    try {
      if (this.isDestroyed || !event?.results) return;
      for (let index = Number(event.resultIndex) || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result?.[0];
        const transcript = typeof alternative?.transcript === "string" ? alternative.transcript : "";
        const isFinal = result?.isFinal === true;
        this.handleTranscript(transcript, { isFinal });
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _handleRecognitionError(event) {
    try {
      const message = typeof event?.error === "string" && event.error
        ? `Speech recognition error: ${event.error}`
        : "Speech recognition failed.";
      const error = new Error(message);
      error.name = "SpeechRecognitionError";
      this._reportError(error);
      this.isRunning = false;
      this._startRequested = false;
      this._notifyStatus("error", event?.error ?? null);
    } catch (error) {
      this._reportError(error);
    }
  }

  _handleEnd() {
    try {
      this.isRunning = false;
      this._startRequested = false;
      this._notifyStatus(this._stopRequested ? "stopped" : "ended");
    } catch (error) {
      this._reportError(error);
    }
  }

  _applyMediaCommand(command) {
    try {
      const media = this.mediaElement;
      if (!media || typeof media !== "object") return;
      switch (command.command) {
        case "play":
          if (typeof media.play === "function") Promise.resolve(media.play()).catch((error) => this._reportError(error));
          break;
        case "pause":
          if (typeof media.pause === "function") media.pause();
          break;
        case "toggle":
          if (media.paused && typeof media.play === "function") Promise.resolve(media.play()).catch((error) => this._reportError(error));
          else if (typeof media.pause === "function") media.pause();
          break;
        case "mute":
          media.muted = true;
          break;
        case "unmute":
          media.muted = false;
          break;
        case "volumeUp":
          media.volume = Math.min(1, boundedNumber(media.volume, 1, 0, 1) + this.volumeStep);
          break;
        case "volumeDown":
          media.volume = Math.max(0, boundedNumber(media.volume, 1, 0, 1) - this.volumeStep);
          break;
        case "seekForward":
          if (Number.isFinite(Number(media.currentTime))) media.currentTime += command.seconds ?? this.seekSeconds;
          break;
        case "seekBackward":
          if (Number.isFinite(Number(media.currentTime))) media.currentTime = Math.max(0, media.currentTime - (command.seconds ?? this.seekSeconds));
          break;
        default:
          break;
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _notifyTranscript(transcript, isFinal) {
    try {
      if (this.onTranscript) this.onTranscript(Object.freeze({ transcript, isFinal }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _notifyCommand(command) {
    try {
      if (this.onCommand) this.onCommand(command);
    } catch (error) {
      this._reportError(error);
    }
  }

  _notifyStatus(status, detail = null) {
    try {
      if (this.onStatus) this.onStatus(Object.freeze({ status, detail }));
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Voice command control failed.");
      if (this.onError) this.onError(this.lastError);
    } catch {
      // Error callbacks must not interrupt recognition cleanup.
    }
  }
}

/** Create a voice-command controller without throwing on unsupported browsers. */
export function createVoiceCommandControl(options = {}) {
  try {
    return new VoiceCommandControl(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  VoiceCommandControl,
  createVoiceCommandControl,
  matchVoiceCommand,
});
