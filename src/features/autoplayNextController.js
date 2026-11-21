const DEFAULT_COUNTDOWN_SECONDS = 10;
const DEFAULT_TICK_INTERVAL_MS = 250;
const DEFAULT_STORAGE_KEY = "trick-a4if-tube:autoplay-next:v1";
const memoryStorage = new Map();
const EVENTS = Object.freeze(["statechange", "tick", "trigger", "error"]);

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeNonNegative(value, fallback) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizePositive(value, fallback) {
  try {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  } catch {
    return fallback;
  }
}

function normalizeText(value, fallback, maxLength = 512) {
  try {
    return typeof value === "string" && value.trim()
      ? value.trim().slice(0, maxLength)
      : fallback;
  } catch {
    return fallback;
  }
}

function resolveStorage(candidate) {
  try {
    if (
      candidate &&
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function"
    ) {
      return candidate;
    }
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Manage an optional autoplay-next countdown.
 * Durations are expressed in seconds. Reaching zero calls resolveNextItem.
 * The controller resolves the next item but does not own playback navigation.
 */
export class AutoplayNextController {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};

    this.countdownSeconds = normalizeNonNegative(
      settings.countdownSeconds ?? settings.durationSeconds,
      DEFAULT_COUNTDOWN_SECONDS,
    );
    this.tickIntervalMs = Math.max(
      50,
      normalizePositive(settings.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS),
    );
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, DEFAULT_STORAGE_KEY);
    this.resolveNextItem = typeof settings.resolveNextItem === "function"
      ? settings.resolveNextItem
      : (typeof settings.onNext === "function" ? settings.onNext : null);
    this.onTick = typeof settings.onTick === "function" ? settings.onTick : null;
    this.onStateChange = typeof settings.onStateChange === "function"
      ? settings.onStateChange
      : null;
    this.onTrigger = typeof settings.onTrigger === "function" ? settings.onTrigger : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;

    this.enabled = settings.enabled === true;
    this.state = "idle";
    this.remainingSeconds = this.countdownSeconds;
    this.lastError = null;
    this.lastResult = null;
    this.isDestroyed = false;

    this._deadline = null;
    this._timerId = null;
    this._listeners = new Map(EVENTS.map((event) => [event, new Set()]));

    this._loadPreference();
    if (this.enabled) this._persistPreference();
  }

  /** Enable or disable autoplay-next. Disabling cancels an active countdown. */
  setEnabled(enabled) {
    try {
      if (this.isDestroyed) return false;
      const nextEnabled = Boolean(enabled);
      if (this.enabled === nextEnabled) return true;

      this.enabled = nextEnabled;
      this._persistPreference();

      if (!nextEnabled && (this.state === "countdown" || this.state === "paused")) {
        this.cancel();
      } else {
        this._emitStateChange(nextEnabled ? "enabled" : "disabled");
      }
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  enable() {
    return this.setEnabled(true);
  }

  disable() {
    return this.setEnabled(false);
  }

  /** Set the default countdown duration in seconds. */
  setCountdownDuration(seconds) {
    try {
      if (this.isDestroyed || this.state === "countdown" || this.state === "paused") {
        return false;
      }
      const duration = normalizeNonNegative(seconds, -1);
      if (duration < 0) return false;

      this.countdownSeconds = duration;
      this.remainingSeconds = duration;
      this._emitTick("duration");
      this._emitStateChange("duration");
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Start or restart the countdown. */
  start(seconds = this.countdownSeconds) {
    try {
      if (this.isDestroyed || !this.enabled) return false;
      const duration = normalizeNonNegative(seconds, -1);
      if (duration < 0) return false;

      this._stopTimer();
      this.countdownSeconds = duration;
      this.remainingSeconds = duration;
      this.lastResult = null;

      if (duration === 0) {
        this.state = "countdown";
        this._emitStateChange("start");
        this._emitTick("start");
        this.triggerNow();
        return true;
      }

      this._deadline = Date.now() + duration * 1000;
      this.state = "countdown";
      this._emitStateChange("start");
      this._emitTick("start");
      this._scheduleTick();
      return true;
    } catch (error) {
      this._reportError(error);
      this._stopTimer();
      return false;
    }
  }

  /** Cancel a running or paused countdown. */
  cancel() {
    try {
      if (this.isDestroyed) return false;
      if (this.state !== "countdown" && this.state !== "paused") return true;

      this._stopTimer();
      this._deadline = null;
      this.remainingSeconds = 0;
      this.state = "cancelled";
      this._emitTick("cancel");
      this._emitStateChange("cancel");
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Pause the countdown while preserving its remaining duration. */
  pause() {
    try {
      if (this.isDestroyed || this.state !== "countdown") return false;
      this._refreshRemaining();
      this._stopTimer();
      this._deadline = null;
      this.state = "paused";
      this._emitTick("pause");
      this._emitStateChange("pause");
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Resume a paused countdown. */
  resume() {
    try {
      if (this.isDestroyed || !this.enabled || this.state !== "paused") return false;

      if (this.remainingSeconds <= 0) {
        this.triggerNow();
        return true;
      }

      this._deadline = Date.now() + this.remainingSeconds * 1000;
      this.state = "countdown";
      this._emitStateChange("resume");
      this._emitTick("resume");
      this._scheduleTick();
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Resolve the next item immediately. */
  triggerNow() {
    try {
      if (this.isDestroyed || !this.enabled) return false;

      this._stopTimer();
      this._deadline = null;
      this.remainingSeconds = 0;
      this.state = "triggered";
      this._emitTick("trigger");
      this._emitStateChange("trigger");

      let result = null;
      if (this.resolveNextItem) {
        try {
          result = this.resolveNextItem(this.getState(), this);
        } catch (error) {
          this._reportError(error);
        }
      }

      this.lastResult = result;
      const detail = Object.freeze({ result, state: this.getState() });
      this._emit("trigger", detail);
      this._safeInvoke(this.onTrigger, detail);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Return an immutable snapshot of the current controller state. */
  getState() {
    try {
      const remaining = this.state === "countdown"
        ? this._currentRemaining()
        : this.remainingSeconds;

      return Object.freeze({
        enabled: this.enabled,
        state: this.state,
        countdownSeconds: this.countdownSeconds,
        remainingSeconds: Math.max(0, remaining),
        remainingWholeSeconds: Math.ceil(Math.max(0, remaining)),
        isDestroyed: this.isDestroyed,
        lastResult: this.lastResult,
      });
    } catch {
      return null;
    }
  }

  addEventListener(type, listener) {
    try {
      const listeners = this._listeners.get(type);
      if (!listeners || typeof listener !== "function" || this.isDestroyed) return false;
      listeners.add(listener);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  removeEventListener(type, listener) {
    try {
      return this._listeners.get(type)?.delete(listener) ?? false;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  /** Stop timers and release callbacks and listeners. */
  destroy() {
    try {
      if (this.isDestroyed) return true;

      this._stopTimer();
      this._deadline = null;
      this.remainingSeconds = 0;
      this.state = "destroyed";
      this._emitStateChange("destroy");

      for (const listeners of this._listeners.values()) listeners.clear();
      this.resolveNextItem = null;
      this.onTick = null;
      this.onStateChange = null;
      this.onTrigger = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      this._stopTimer();
      return false;
    }
  }

  _scheduleTick() {
    try {
      if (this.isDestroyed || this.state !== "countdown" || this._timerId !== null) return;
      this._timerId = setTimeout(() => {
        this._timerId = null;
        this._onTick();
      }, this.tickIntervalMs);

      if (this._timerId && typeof this._timerId.unref === "function") {
        this._timerId.unref();
      }
    } catch (error) {
      this._reportError(error);
      this._stopTimer();
    }
  }

  _onTick() {
    try {
      if (this.isDestroyed || this.state !== "countdown") return;

      this._refreshRemaining();
      this._emitTick("interval");

      if (this.remainingSeconds <= 0) {
        this.triggerNow();
        return;
      }
      this._scheduleTick();
    } catch (error) {
      this._reportError(error);
    }
  }

  _refreshRemaining() {
    try {
      if (this._deadline !== null) {
        this.remainingSeconds = Math.max(0, (this._deadline - Date.now()) / 1000);
      }
      return this.remainingSeconds;
    } catch {
      return this.remainingSeconds;
    }
  }

  _currentRemaining() {
    try {
      return this.state === "countdown"
        ? this._refreshRemaining()
        : this.remainingSeconds;
    } catch {
      return this.remainingSeconds;
    }
  }

  _stopTimer() {
    try {
      if (this._timerId !== null) clearTimeout(this._timerId);
      this._timerId = null;
      return true;
    } catch {
      this._timerId = null;
      return false;
    }
  }

  _emitTick(reason) {
    try {
      const detail = Object.freeze({ ...this.getState(), reason });
      this._emit("tick", detail);
      this._safeInvoke(this.onTick, detail);
    } catch (error) {
      this._reportError(error);
    }
  }

  _emitStateChange(reason) {
    try {
      const detail = Object.freeze({ ...this.getState(), reason });
      this._emit("statechange", detail);
      this._safeInvoke(this.onStateChange, detail);
    } catch (error) {
      this._reportError(error);
    }
  }

  _emit(type, detail) {
    try {
      const listeners = this._listeners.get(type);
      if (!listeners) return;
      for (const listener of [...listeners]) this._safeInvoke(listener, detail);
    } catch (error) {
      this._reportError(error);
    }
  }

  _safeInvoke(callback, detail) {
    try {
      if (typeof callback === "function") callback(detail, this);
    } catch (error) {
      this._reportError(error);
    }
  }

  _loadPreference() {
    try {
      let raw = null;
      if (this.storage) raw = this.storage.getItem(this.storageKey);
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (raw === null) return;

      const preference = JSON.parse(raw);
      if (isRecord(preference) && typeof preference.enabled === "boolean") {
        this.enabled = preference.enabled;
      }
    } catch (error) {
      this._reportError(error);
    }
  }

  _persistPreference() {
    try {
      const value = JSON.stringify({ version: 1, enabled: this.enabled });
      memoryStorage.set(this.storageKey, value);

      if (this.storage) {
        try {
          this.storage.setItem(this.storageKey, value);
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

  _reportError(error) {
    try {
      this.lastError = error instanceof Error
        ? error
        : new Error("Autoplay-next operation failed.");

      this._emit("error", Object.freeze({ error: this.lastError }));
      if (this.onError) {
        try {
          this.onError(this.lastError, this);
        } catch {
          // Error callbacks must not escape controller operations.
        }
      }
    } catch {
      // Error reporting must not interrupt controller operations or cleanup.
    }
  }
}

/** Create an autoplay-next controller without throwing on initialization errors. */
export function createAutoplayNextController(options = {}) {
  try {
    return new AutoplayNextController(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  AutoplayNextController,
  createAutoplayNextController,
});
