const STORAGE_KEY = "trick-a4if-tube:theater-cinema-mode:v1";
const memoryStorage = new Map();
const STATE_EVENT = "statechange";

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, fallback = "", maxLength = 512) {
  try {
    if (typeof value !== "string") return fallback;
    const text = value.trim().slice(0, maxLength);
    return text || fallback;
  } catch {
    return fallback;
  }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") {
      return candidate;
    }
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveDocument(candidate) {
  try {
    if (candidate && typeof candidate.addEventListener === "function"
      && typeof candidate.removeEventListener === "function") return candidate;
    return typeof globalThis.document !== "undefined' ? globalThis.document : null;
  } catch {
    return null;
  }
}

/**
 * Manage theater/cinema mode and optionally synchronize it with a DOM element.
 * DOM and storage integrations are optional and guarded for SSR/restricted
 * environments. This manager changes only the class and attribute it owns.
 */
export class TheaterCinemaModeManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, STORAGE_KEY);
    this.onStateChange = typeof settings.onStateChange === "function" ? settings.onStateChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._listeners = new Set();

    this.targetElement = settings.targetElement ?? settings.element ?? null;
    this.body = settings.body ?? null;
    this.bodyClass = normalizeText(settings.bodyClass, "", 128);
    this.dataAttribute = normalizeText(settings.dataAttribute, "", 128);
    this.attributeTarget = settings.attributeTarget ?? this.targetElement ?? this.body ?? null;
    this.escapeToExit = settings.escapeToExit === true || settings.closeOnEscape === true;
    this.escapeTarget = resolveDocument(settings.escapeTarget);
    this._escapeListenerAttached = false;
    this._boundKeyDown = (event) => this._handleKeyDown(event);
    this._originalDomState = this._captureDomState();

    const stored = this._loadPreference();
    this.enabled = typeof settings.enabled === "boolean"
      ? settings.enabled
      : (typeof stored === "boolean" ? stored : false);
    this.active = this.enabled;

    this._syncDom();
    this._syncEscapeListener();
    if (this.enabled) this._persistPreference();
  }

  /** Enable theater/cinema mode. */
  enable() {
    return this.setEnabled(true);
  }

  /** Disable theater/cinema mode. */
  disable() {
    return this.setEnabled(false);
  }

  /** Toggle mode, or set it to the supplied boolean value. */
  toggle(force) {
    try {
      if (this.isDestroyed) return false;
      return this.setEnabled(typeof force === "boolean" ? force : !this.enabled);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  setEnabled(enabled) {
    try {
      if (this.isDestroyed) return false;
      const next = Boolean(enabled);
      if (next === this.enabled) {
        this._syncDom();
        this._syncEscapeListener();
        return true;
      }

      const previous = this.enabled;
      this.enabled = next;
      this.active = next;
      this._syncDom();
      this._syncEscapeListener();
      this._persistPreference();
      this._emitStateChange(previous ? "disable" : "enable", previous);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Register a state listener; returns an unsubscribe function. */
  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => false;
      this._listeners.add(listener);
      let subscribed = true;
      return () => {
        try {
          if (!subscribed) return false;
          subscribed = false;
          return this._listeners.delete(listener);
        } catch {
          return false;
        }
      };
    } catch (error) {
      this._reportError(error);
      return () => false;
    }
  }

  unsubscribe(listener) {
    try {
      return this._listeners.delete(listener);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  addEventListener(type, listener) {
    try {
      if (type !== STATE_EVENT) return false;
      return typeof this.subscribe(listener) === "function" && !this.isDestroyed
        ? (this._listeners.has(listener) || this._listeners.add(listener), true)
        : false;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  removeEventListener(type, listener) {
    try {
      return type === STATE_EVENT ? this.unsubscribe(listener) : false;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  getState() {
    try {
      return Object.freeze({
        enabled: this.enabled,
        active: this.active,
        isDestroyed: this.isDestroyed,
      });
    } catch {
      return null;
    }
  }

  /** Remove key handlers and restore the DOM state captured at construction. */
  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._removeEscapeListener();
      this._restoreDomState();
      this._listeners.clear();
      this.enabled = false;
      this.active = false;
      this.isDestroyed = true;
      this.targetElement = null;
      this.attributeTarget = null;
      this.body = null;
      this.escapeTarget = null;
      this.storage = null;
      this.onStateChange = null;
      this.onError = null;
      return true;
    } catch (error) {
      this._reportError(error);
      this._removeEscapeListener();
      this.isDestroyed = true;
      return false;
    }
  }

  _captureDomState() {
    try {
      const state = {};
      if (this.bodyClass && this.body?.classList
        && typeof this.body.classList.contains === "function") {
        state.bodyClassPresent = this.body.classList.contains(this.bodyClass);
      }
      if (this.dataAttribute && this.attributeTarget
        && typeof this.attributeTarget.getAttribute === "function") {
        state.attributePresent = typeof this.attributeTarget.hasAttribute === "function"
          ? this.attributeTarget.hasAttribute(this.dataAttribute)
          : this.attributeTarget.getAttribute(this.dataAttribute) !== null;
        state.attributeValue = this.attributeTarget.getAttribute(this.dataAttribute);
      }
      return state;
    } catch (error) {
      this._reportError(error);
      return {};
    }
  }

  _syncDom() {
    try {
      if (this.bodyClass && this.body?.classList) {
        if (this.enabled && typeof this.body.classList.add === "function") {
          this.body.classList.add(this.bodyClass);
        } else if (!this.enabled && typeof this.body.classList.remove === "function") {
          this.body.classList.remove(this.bodyClass);
        }
      }
      if (this.dataAttribute && this.attributeTarget
        && typeof this.attributeTarget.setAttribute === "function") {
        this.attributeTarget.setAttribute(this.dataAttribute, this.enabled ? "true" : "false");
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _restoreDomState() {
    try {
      if (this.bodyClass && this.body?.classList) {
        const wasPresent = this._originalDomState?.bodyClassPresent === true;
        if (wasPresent && typeof this.body.classList.add === "function") {
          this.body.classList.add(this.bodyClass);
        } else if (!wasPresent && typeof this.body.classList.remove === "function") {
          this.body.classList.remove(this.bodyClass);
        }
      }
      if (this.dataAttribute && this.attributeTarget
        && typeof this.attributeTarget.setAttribute === "function") {
        if (this._originalDomState?.attributePresent) {
          this.attributeTarget.setAttribute(this.dataAttribute, this._originalDomState.attributeValue ?? "");
        } else if (typeof this.attributeTarget.removeAttribute === "function") {
          this.attributeTarget.removeAttribute(this.dataAttribute);
        }
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _syncEscapeListener() {
    try {
      if (!this.escapeToExit || !this.escapeTarget || this.isDestroyed) return false;
      if (this.enabled && !this._escapeListenerAttached) {
        this.escapeTarget.addEventListener("keydown", this._boundKeyDown);
        this._escapeListenerAttached = true;
      } else if (!this.enabled) {
        this._removeEscapeListener();
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _removeEscapeListener() {
    try {
      if (this._escapeListenerAttached && this.escapeTarget
        && typeof this.escapeTarget.removeEventListener === "function") {
        this.escapeTarget.removeEventListener("keydown", this._boundKeyDown);
      }
      this._escapeListenerAttached = false;
      return true;
    } catch (error) {
      this._escapeListenerAttached = false;
      this._reportError(error);
      return false;
    }
  }

  _handleKeyDown(event) {
    try {
      if (this.isDestroyed || !this.enabled || event?.key !== "Escape") return;
      if (event.defaultPrevented) return;
      this.disable();
    } catch (error) {
      this._reportError(error);
    }
  }

  _loadPreference() {
    try {
      let raw = null;
      try {
        raw = this.storage?.getItem(this.storageKey) ?? null;
      } catch (error) {
        this._reportError(error);
      }
      if (raw === null) raw = memoryStorage.get(this.storageKey) ?? null;
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.enabled === "boolean") return parsed.enabled;
      if (typeof parsed === "boolean") return parsed;
      return null;
    } catch (error) {
      this._reportError(error);
      return null;
    }
  }

  _persistPreference() {
    try {
      const serialized = JSON.stringify({ version: 1, enabled: this.enabled });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try {
          this.storage.setItem(this.storageKey, serialized);
        } catch (error) {
          this._reportError(error);
        }
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _emitStateChange(reason, previousEnabled = this.enabled) {
    try {
      const detail = Object.freeze({ ...this.getState(), previousEnabled, reason });
      try {
        this.onStateChange?.(detail, this);
      } catch (error) {
        this._reportError(error);
      }
      for (const listener of [...this._listeners]) {
        try {
          listener(detail, this);
        } catch (error) {
          this._reportError(error);
        }
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error
        ? error
        : new Error("Theater/cinema mode operation failed.");
      try {
        this.onError?.(this.lastError, this);
      } catch {
        // Error callbacks must not escape manager operations.
      }
    } catch {
      // Error reporting must not interrupt state changes or teardown.
    }
  }
}

/** Create a theater/cinema mode manager without throwing on restricted platforms. */
export function createTheaterCinemaModeManager(options = {}) {
  try {
    return new TheaterCinemaModeManager(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  TheaterCinemaModeManager,
  createTheaterCinemaModeManager,
});
