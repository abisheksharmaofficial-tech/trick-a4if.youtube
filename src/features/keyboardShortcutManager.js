const DEFAULT_SHORTCUTS = Object.freeze([
  Object.freeze({ shortcut: "Space", action: "togglePlayPause", description: "Toggle playback" }),
  Object.freeze({ shortcut: "K", action: "togglePlayPause", description: "Toggle playback" }),
  Object.freeze({ shortcut: "M", action: "toggleMute", description: "Toggle mute" }),
  Object.freeze({ shortcut: "ArrowUp", action: "volumeUp", description: "Increase volume" }),
  Object.freeze({ shortcut: "ArrowDown", action: "volumeDown", description: "Decrease volume" }),
  Object.freeze({ shortcut: "ArrowLeft", action: "seekBackward", description: "Seek backward" }),
  Object.freeze({ shortcut: "ArrowRight", action: "seekForward", description: "Seek forward" }),
  Object.freeze({ shortcut: "J", action: "seekBackward", description: "Seek backward" }),
  Object.freeze({ shortcut: "L", action: "seekForward", description: "Seek forward" }),
  Object.freeze({ shortcut: "F", action: "toggleFullscreen", description: "Toggle fullscreen" }),
  Object.freeze({ shortcut: "N", action: "next", description: "Play next" }),
  Object.freeze({ shortcut: "P", action: "previous", description: "Play previous" }),
  Object.freeze({ shortcut: "/", action: "focusSearch", description: "Focus search" }),
  Object.freeze({ shortcut: "Shift+/", action: "showShortcuts", description: "Show keyboard shortcuts" }),
]);

const MODIFIER_ALIASES = Object.freeze({
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
});

const MODIFIER_ORDER = Object.freeze(["ctrl", "alt", "shift", "meta"]);
const SHIFTED_KEYS = Object.freeze({
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
});
const CODE_TO_KEY = Object.freeze({
  Space: "space",
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
});
const DEFAULT_SEEK_SECONDS = 5;
const DEFAULT_VOLUME_STEP = 0.05;

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeKey(value) {
  try {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    const lower = trimmed.toLowerCase();
    const aliases = {
      " ": "space", spacebar: "space", esc: "escape", del: "delete",
      left: "arrowleft", right: "arrowright", up: "arrowup", down: "arrowdown",
    };
    if (aliases[lower]) return aliases[lower];
    if (SHIFTED_KEYS[trimmed]) return SHIFTED_KEYS[trimmed];
    if (/^arrow(left|right|up|down)$/i.test(trimmed)) return lower;
    if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return lower;
    return lower.length === 1 ? lower : lower;
  } catch {
    return "";
  }
}

function parseShortcut(shortcut) {
  try {
    if (isRecord(shortcut)) {
      const key = normalizeKey(shortcut.key);
      if (!key) return null;
      const modifiers = new Set();
      const source = Array.isArray(shortcut.modifiers) ? shortcut.modifiers : [];
      for (const modifier of source) {
        const normalized = MODIFIER_ALIASES[String(modifier).toLowerCase()];
        if (normalized) modifiers.add(normalized);
      }
      if (SHIFTED_KEYS[String(shortcut.key)] ) modifiers.add("shift");
      for (const name of MODIFIER_ORDER) {
        if (shortcut[name] === true || (name === "ctrl" && shortcut.control === true)) modifiers.add(name);
      }
      return { key, modifiers };
    }

    if (typeof shortcut !== "string" || !shortcut.trim()) return null;
    const tokens = shortcut.trim().split("+").map((part) => part.trim()).filter(Boolean);
    if (!tokens.length) return null;
    const modifiers = new Set();
    let key = "";
    for (const token of tokens) {
      const modifier = MODIFIER_ALIASES[token.toLowerCase()];
      if (modifier) {
        modifiers.add(modifier);
      } else if (key) {
        return null;
      } else {
        key = normalizeKey(token);
        if (SHIFTED_KEYS[token]) modifiers.add("shift");
      }
    }
    return key ? { key, modifiers } : null;
  } catch {
    return null;
  }
}

function shortcutId(parsed) {
  try {
    if (!parsed) return "";
    const modifiers = MODIFIER_ORDER.filter((name) => parsed.modifiers.has(name));
    return [...modifiers, parsed.key].join("+");
  } catch {
    return "";
  }
}

function eventKey(event) {
  try {
    const code = typeof event?.code === "string" ? event.code : "";
    if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    const key = typeof event?.key === "string" ? event.key : "";
    if (key && SHIFTED_KEYS[key]) return SHIFTED_KEYS[key];
    return normalizeKey(key);
  } catch {
    return "";
  }
}

function eventModifiers(event) {
  try {
    const modifiers = new Set();
    if (event?.ctrlKey) modifiers.add("ctrl");
    if (event?.altKey) modifiers.add("alt");
    if (event?.shiftKey) modifiers.add("shift");
    if (event?.metaKey) modifiers.add("meta");
    return modifiers;
  } catch {
    return new Set();
  }
}

function isEditableTarget(target) {
  try {
    let node = target;
    while (node && typeof node === "object") {
      const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
      if (["input", "textarea", "select"].includes(tag)) return true;
      if (node.isContentEditable === true) return true;
      const editable = typeof node.getAttribute === "function" ? node.getAttribute("contenteditable") : null;
      if (editable !== null && String(editable).toLowerCase() !== "false") return true;
      node = node.parentElement ?? null;
    }
    return false;
  } catch {
    return false;
  }
}

function safeCall(callback, args, manager) {
  try {
    if (typeof callback !== "function") return false;
    callback(...args);
    return true;
  } catch (error) {
    manager._reportError(error);
    return false;
  }
}

/**
 * Manage keyboard shortcuts for a media player or another browser UI.
 * Actions are caller-controlled; browser defaults are only prevented when a
 * matching action is available and successfully invoked.
 */
export class KeyboardShortcutManager {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.target = settings.target ?? settings.eventTarget ?? null;
      this.document = settings.document ?? this.target?.ownerDocument ?? globalThis.document ?? null;
      this.mediaElement = settings.mediaElement ?? settings.videoElement ?? null;
      this.searchElement = settings.searchElement ?? settings.searchInput ?? null;
      this.actions = isRecord(settings.actions) ? { ...settings.actions } : {};
      this.seekSeconds = this._positiveNumber(settings.seekSeconds, DEFAULT_SEEK_SECONDS);
      this.volumeStep = this._positiveNumber(settings.volumeStep, DEFAULT_VOLUME_STEP);
      this.enabled = settings.enabled !== false;
      this.isAttached = false;
      this.isDestroyed = false;
      this.lastError = null;
      this._shortcuts = new Map();
      this._boundKeydown = (event) => this._handleKeydown(event);

      const callbacks = {
        togglePlayPause: settings.onPlayPause ?? settings.onTogglePlayPause,
        toggleMute: settings.onMute ?? settings.onToggleMute,
        volumeUp: settings.onVolumeUp,
        volumeDown: settings.onVolumeDown,
        seekBackward: settings.onSeekBackward,
        seekForward: settings.onSeekForward,
        toggleFullscreen: settings.onFullscreen ?? settings.onToggleFullscreen,
        next: settings.onNext,
        previous: settings.onPrevious,
        focusSearch: settings.onFocusSearch,
        showShortcuts: settings.onShowShortcuts,
      };
      for (const [name, callback] of Object.entries(callbacks)) {
        if (typeof callback === "function") this.actions[name] = callback;
      }

      const overrides = isRecord(settings.shortcuts) ? settings.shortcuts : null;
      for (const definition of DEFAULT_SHORTCUTS) {
        const configured = overrides && Object.prototype.hasOwnProperty.call(overrides, definition.shortcut)
          ? overrides[definition.shortcut]
          : null;
        if (configured === false) continue;
        const action = typeof configured === "function" ? configured
          : (isRecord(configured) && typeof configured.handler === "function") ? configured.handler
            : definition.action;
        const extra = isRecord(configured) ? configured : {};
        this.registerShortcut(definition.shortcut, action, {
          description: extra.description ?? definition.description,
          enabled: extra.enabled !== false,
          preventDefault: extra.preventDefault !== false,
          allowInEditable: extra.allowInEditable === true,
          id: extra.id,
        });
      }
      if (overrides) {
        for (const [shortcut, configured] of Object.entries(overrides)) {
          if (DEFAULT_SHORTCUTS.some((item) => item.shortcut === shortcut) || configured === false) continue;
          if (typeof configured === "function") this.registerShortcut(shortcut, configured);
          else if (isRecord(configured)) {
            this.registerShortcut(shortcut, configured.handler ?? configured.action, configured);
          }
        }
      }
      if (settings.autoAttach === true) this.attach(this.target);
    } catch (error) {
      this.lastError = error;
      this.enabled = false;
      this.isAttached = false;
      this.isDestroyed = false;
      this._shortcuts = this._shortcuts instanceof Map ? this._shortcuts : new Map();
    }
  }

  _positiveNumber(value, fallback) {
    try {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : fallback;
    } catch {
      return fallback;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Keyboard shortcut action failed.");
      safeCall(this.onError, [this.lastError], this);
    } catch {
      // Error reporting must not interrupt shortcut handling or cleanup.
    }
  }

  _resolveAction(action) {
    try {
      if (typeof action === "function") return action;
      if (typeof action !== "string") return null;
      if (typeof this.actions[action] === "function") return this.actions[action];

      const media = this.mediaElement;
      switch (action) {
        case "togglePlayPause":
          if (!media) return null;
          return () => {
            if (media.paused) {
              const result = media.play?.();
              if (result && typeof result.catch === "function") result.catch((error) => this._reportError(error));
            } else media.pause?.();
          };
        case "toggleMute":
          return media ? () => { media.muted = !media.muted; } : null;
        case "volumeUp":
          return media ? () => { media.volume = Math.min(1, Number(media.volume || 0) + this.volumeStep); } : null;
        case "volumeDown":
          return media ? () => { media.volume = Math.max(0, Number(media.volume || 0) - this.volumeStep); } : null;
        case "seekBackward":
          return media && Number.isFinite(Number(media.currentTime))
            ? () => { media.currentTime = Math.max(0, Number(media.currentTime) - this.seekSeconds); }
            : null;
        case "seekForward":
          return media && Number.isFinite(Number(media.currentTime))
            ? () => {
              const duration = Number(media.duration);
              const nextTime = Number(media.currentTime) + this.seekSeconds;
              media.currentTime = Number.isFinite(duration) ? Math.min(duration, nextTime) : nextTime;
            }
            : null;
        case "toggleFullscreen":
          return this.document?.fullscreenElement
            ? () => this.document.exitFullscreen?.()
            : (this.target?.requestFullscreen || media?.requestFullscreen)
              ? () => (this.target ?? media).requestFullscreen?.()
              : null;
        case "focusSearch":
          return this.searchElement && typeof this.searchElement.focus === "function"
            ? () => this.searchElement.focus()
            : null;
        default:
          return null;
      }
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _handleKeydown(event) {
    try {
      if (this.isDestroyed || !this.enabled || !event || event.defaultPrevented) return false;
      if (isEditableTarget(event.target)) return false;
      const key = eventKey(event);
      if (!key) return false;
      const modifiers = eventModifiers(event);

      for (const entry of this._shortcuts.values()) {
        if (!entry.enabled || entry.key !== key || entry.modifiers.size !== modifiers.size) continue;
        if (!MODIFIER_ORDER.every((modifier) => entry.modifiers.has(modifier) === modifiers.has(modifier))) continue;
        const handler = this._resolveAction(entry.action);
        if (!handler) continue;
        if (!safeCall(handler, [event, this], this)) return false;
        if (entry.preventDefault) {
          try { event.preventDefault?.(); } catch { /* Synthetic or restricted event. */ }
        }
        return true;
      }
      return false;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Register a shortcut string or { key, modifiers } definition. */
  registerShortcut(shortcut, handler, options = {}) {
    try {
      if (this.isDestroyed) return false;
      let definition = shortcut;
      let callback = handler;
      let settings = isRecord(options) ? options : {};
      if (isRecord(shortcut) && shortcut.shortcut) {
        definition = shortcut.shortcut;
        callback = handler ?? shortcut.handler ?? shortcut.action;
        settings = { ...shortcut, ...settings };
      }
      const parsed = parseShortcut(definition);
      if (!parsed || (typeof callback !== "function" && typeof callback !== "string")) return false;
      const id = typeof settings.id === "string" && settings.id.trim()
        ? settings.id.trim()
        : shortcutId(parsed);
      if (!id) return false;
      this._shortcuts.set(id, {
        id,
        key: parsed.key,
        modifiers: new Set(parsed.modifiers),
        action: callback,
        description: typeof settings.description === "string" ? settings.description : "",
        enabled: settings.enabled !== false,
        preventDefault: settings.preventDefault !== false,
        allowInEditable: settings.allowInEditable === true,
      });
      return id;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Remove a shortcut by its original shortcut string or registered id. */
  unregisterShortcut(shortcutOrId) {
    try {
      if (this.isDestroyed) return false;
      const key = typeof shortcutOrId === "string" ? shortcutId(parseShortcut(shortcutOrId)) : "";
      return this._shortcuts.delete(key || String(shortcutOrId ?? ""));
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  enableShortcut(shortcutOrId) { return this._setShortcutEnabled(shortcutOrId, true); }
  disableShortcut(shortcutOrId) { return this._setShortcutEnabled(shortcutOrId, false); }

  _setShortcutEnabled(shortcutOrId, enabled) {
    try {
      if (this.isDestroyed) return false;
      const parsedId = typeof shortcutOrId === "string" ? shortcutId(parseShortcut(shortcutOrId)) : "";
      const entry = this._shortcuts.get(parsedId || String(shortcutOrId ?? ""));
      if (!entry) return false;
      entry.enabled = enabled;
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Return an immutable snapshot of the current shortcut definitions. */
  listShortcuts() {
    try {
      return Array.from(this._shortcuts.values(), (entry) => Object.freeze({
        id: entry.id,
        shortcut: [...MODIFIER_ORDER.filter((name) => entry.modifiers.has(name)), entry.key].join("+"),
        key: entry.key,
        modifiers: Object.freeze(MODIFIER_ORDER.filter((name) => entry.modifiers.has(name))),
        action: typeof entry.action === "string" ? entry.action : "custom",
        description: entry.description,
        enabled: entry.enabled,
        preventDefault: entry.preventDefault,
      }));
    } catch (error) {
      this._reportError(error);
      return [];
    }
  }

  enable() {
    try { if (this.isDestroyed) return false; this.enabled = true; return true; }
    catch (error) { this._reportError(error); return false; }
  }

  disable() {
    try { if (this.isDestroyed) return false; this.enabled = false; return true; }
    catch (error) { this._reportError(error); return false; }
  }

  attach(target = this.target) {
    try {
      if (this.isDestroyed || !target || typeof target.addEventListener !== "function") return false;
      if (this.isAttached && this.target === target) return true;
      this.detach();
      this.target = target;
      if (!this.document) this.document = target.ownerDocument ?? null;
      target.addEventListener("keydown", this._boundKeydown);
      this.isAttached = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isAttached = false;
      return false;
    }
  }

  detach() {
    try {
      if (this.isAttached && this.target && typeof this.target.removeEventListener === "function") {
        this.target.removeEventListener("keydown", this._boundKeydown);
      }
      this.isAttached = false;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isAttached = false;
      return false;
    }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this.detach();
      this.enabled = false;
      this._shortcuts.clear();
      this.actions = {};
      this.target = null;
      this.document = null;
      this.mediaElement = null;
      this.searchElement = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }
}

/** Create a shortcut manager without throwing in unsupported environments. */
export function createKeyboardShortcutManager(options = {}) {
  try {
    return new KeyboardShortcutManager(options);
  } catch {
    return null;
  }
}

export { DEFAULT_SHORTCUTS };

export default Object.freeze({
  DEFAULT_SHORTCUTS,
  KeyboardShortcutManager,
  createKeyboardShortcutManager,
});
