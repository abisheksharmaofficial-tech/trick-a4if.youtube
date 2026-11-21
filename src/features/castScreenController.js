const STORAGE_KEY = "trick-a4if-tube:cast-screen:v1";
const memoryStorage = new Map();
const MAX_RECEIVERS = 500;
const MAX_COMMANDS = 1000;
const CONNECTION_STATES = Object.freeze(["idle", "connecting", "connected", "disconnecting", "error"]);
const COMMAND_TYPES = new Set(["load", "play", "pause", "seek", "setVolume", "setMuted", "stop"]);

function isRecord(value) {
  try { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
  catch { return false; }
}

function normalizeText(value, maxLength = 1000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch { return ""; }
}

function normalizeId(value) {
  try {
    if (isRecord(value)) return normalizeText(value.id ?? value.deviceId ?? value.receiverId, 512);
    return normalizeText(value, 512);
  } catch { return ""; }
}

function normalizeCapabilities(value) {
  try {
    if (Array.isArray(value)) return Object.freeze([...new Set(value.map((item) => normalizeText(item, 128)).filter(Boolean))]);
    if (isRecord(value)) {
      const result = {};
      for (const [key, supported] of Object.entries(value)) {
        const normalizedKey = normalizeText(key, 128);
        if (normalizedKey) result[normalizedKey] = Boolean(supported);
      }
      return Object.freeze(result);
    }
    return Object.freeze([]);
  } catch { return Object.freeze([]); }
}

function normalizeReceiver(input) {
  try {
    if (!isRecord(input)) return null;
    const id = normalizeId(input.id ?? input.deviceId ?? input.receiverId);
    if (!id) return null;
    return Object.freeze({
      id,
      name: normalizeText(input.name ?? input.label, 512),
      type: normalizeText(input.type, 128),
      protocol: normalizeText(input.protocol, 128),
      capabilities: normalizeCapabilities(input.capabilities),
    });
  } catch { return null; }
}

function cloneJson(value, fallback = null) {
  try {
    if (value === undefined) return fallback;
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch { return fallback; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeVolume(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null;
  } catch { return null; }
}

/**
 * Manage caller-supplied cast receivers and a transport adapter. This class
 * does not discover devices, connect to external receivers, or simulate casts;
 * operations are delegated only to caller-provided adapters.
 */
export class CastScreenController {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.adapter = isRecord(settings.adapter) ? settings.adapter : null;
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onCommand = typeof settings.onCommand === "function" ? settings.onCommand : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this.connectionState = "idle";
      this.receivers = [];
      this.activeReceiver = null;
      this.session = null;
      this.commandHistory = [];
      this._subscribers = new Set();
      this._operationToken = 0;
      this._load();
      if (Array.isArray(settings.receivers)) this.setReceivers(settings.receivers, { silent: true });
    } catch (error) {
      this._reportError(error);
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.adapter = null;
      this.onChange = null;
      this.onCommand = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this.connectionState = "idle";
      this.receivers = [];
      this.activeReceiver = null;
      this.session = null;
      this.commandHistory = [];
      this._subscribers = new Set();
      this._operationToken = 0;
    }
  }

  setReceivers(receivers, options = {}) {
    try {
      if (this.isDestroyed || !Array.isArray(receivers)) return false;
      const unique = new Map();
      for (const candidate of receivers) {
        const receiver = normalizeReceiver(candidate);
        if (receiver) unique.set(receiver.id, receiver);
        if (unique.size >= MAX_RECEIVERS) break;
      }
      this.receivers = [...unique.values()];
      if (this.activeReceiver && !unique.has(this.activeReceiver.id)) {
        this.activeReceiver = null;
        this.session = null;
        this.connectionState = "idle";
      } else if (this.activeReceiver) {
        this.activeReceiver = unique.get(this.activeReceiver.id);
      }
      this._persist();
      if (options?.silent !== true) this._notify("receivers-updated");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  addReceiver(receiver, options = {}) {
    try {
      const normalized = normalizeReceiver(receiver);
      if (this.isDestroyed || !normalized) return false;
      const receivers = this.receivers.filter((item) => item.id !== normalized.id);
      receivers.push(normalized);
      return this.setReceivers(receivers, options);
    } catch (error) { this._reportError(error); return false; }
  }

  removeReceiver(id, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const normalized = normalizeId(id);
      const receiver = this.receivers.find((item) => item.id === normalized);
      if (!receiver) return false;
      if (this.activeReceiver?.id === normalized) this.disconnect({ silent: true });
      this.receivers = this.receivers.filter((item) => item.id !== normalized);
      this._persist();
      if (options?.silent !== true) this._notify("receiver-removed");
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getReceivers() {
    try { return Object.freeze(this.receivers.slice()); }
    catch { return Object.freeze([]); }
  }

  getReceiver(id) {
    try { const normalized = normalizeId(id); return this.receivers.find((item) => item.id === normalized) ?? null; }
    catch { return null; }
  }

  async connect(receiverOrId, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const receiver = normalizeReceiver(receiverOrId) ?? this.getReceiver(receiverOrId);
      if (!receiver) return false;
      if (this.connectionState === "connected" && this.activeReceiver?.id === receiver.id) return true;
      if (this.connectionState === "connected" || this.connectionState === "connecting") {
        await this.disconnect({ silent: true });
        if (this.isDestroyed) return false;
      }
      const token = ++this._operationToken;
      this.activeReceiver = receiver;
      this.session = null;
      this.connectionState = "connecting";
      this._persist();
      this._notify("connecting");
      let result = null;
      if (typeof this.adapter?.connect === "function") result = await this.adapter.connect(receiver, options);
      if (this.isDestroyed || token !== this._operationToken) return false;
      if (result === false) throw new Error("Cast receiver connection was rejected.");
      this.session = isRecord(result) ? result : null;
      this.connectionState = "connected";
      this._persist();
      this._notify("connected");
      return true;
    } catch (error) {
      if (!this.isDestroyed) {
        this.connectionState = "error";
        this._reportError(error);
        this._persist();
        this._notify("connection-error");
      }
      return false;
    }
  }

  async switchReceiver(receiverOrId, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const receiver = normalizeReceiver(receiverOrId) ?? this.getReceiver(receiverOrId);
      if (!receiver) return false;
      if (this.activeReceiver?.id === receiver.id && this.connectionState === "connected") return true;
      if (this.connectionState !== "idle") await this.disconnect({ silent: true });
      return this.connect(receiver, options);
    } catch (error) { this._reportError(error); return false; }
  }

  async disconnect(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (this.connectionState === "idle" && !this.activeReceiver) return true;
      const token = ++this._operationToken;
      const receiver = this.activeReceiver;
      const session = this.session;
      this.connectionState = "disconnecting";
      this._persist();
      if (options?.silent !== true) this._notify("disconnecting");
      if (typeof this.adapter?.disconnect === "function") await this.adapter.disconnect(session, receiver);
      if (this.isDestroyed || token !== this._operationToken) return false;
      this.connectionState = "idle";
      this.activeReceiver = null;
      this.session = null;
      this._persist();
      if (options?.silent !== true) this._notify("disconnected");
      return true;
    } catch (error) {
      if (!this.isDestroyed) {
        this.connectionState = "error";
        this._reportError(error);
        this._persist();
        this._notify("disconnect-error");
      }
      return false;
    }
  }

  async sendCommand(type, payload = {}) {
    try {
      if (this.isDestroyed || this.connectionState !== "connected" || !COMMAND_TYPES.has(type)) return false;
      const command = Object.freeze({ type, payload: cloneJson(payload, {}), receiverId: this.activeReceiver?.id ?? "", createdAt: Date.now() });
      let result = true;
      if (typeof this.adapter?.sendCommand === "function") result = await this.adapter.sendCommand(command, this.session, this.activeReceiver);
      else if (typeof this.adapter?.[type] === "function") result = await this.adapter[type](command.payload, this.session, this.activeReceiver);
      else return false;
      if (result === false) return false;
      this.commandHistory.push(command);
      if (this.commandHistory.length > MAX_COMMANDS) this.commandHistory.splice(0, this.commandHistory.length - MAX_COMMANDS);
      try { this.onCommand?.(command, this); } catch (error) { this._reportError(error); }
      this._persist();
      this._notify("command");
      return result === undefined ? true : result;
    } catch (error) { this._reportError(error); this._notify("command-error"); return false; }
  }

  load(media, options = {}) { return this.sendCommand("load", { ...(isRecord(media) ? media : { url: media }), ...options }); }
  play(options = {}) { return this.sendCommand("play", options); }
  pause(options = {}) { return this.sendCommand("pause", options); }
  seek(currentTime, options = {}) { return this.sendCommand("seek", { currentTime, ...options }); }
  setVolume(volume, options = {}) {
    try {
      const value = Number(volume);
      if (!Number.isFinite(value)) return Promise.resolve(false);
      return this.sendCommand("setVolume", { volume: Math.min(1, Math.max(0, value)), ...options });
    } catch (error) { this._reportError(error); return Promise.resolve(false); }
  }
  setMuted(muted, options = {}) { return this.sendCommand("setMuted", { muted: Boolean(muted), ...options }); }
  stop(options = {}) { return this.sendCommand("stop", options); }

  getState() {
    try {
      return Object.freeze({
        connectionState: this.connectionState,
        state: this.connectionState,
        receivers: this.getReceivers(),
        activeReceiver: this.activeReceiver,
        session: this.session,
        commandHistory: Object.freeze(this.commandHistory.slice()),
        isDestroyed: this.isDestroyed,
      });
    } catch { return null; }
  }

  subscribe(listener) {
    try {
      if (this.isDestroyed || typeof listener !== "function") return () => {};
      this._subscribers.add(listener);
      return () => { try { this._subscribers.delete(listener); } catch { /* Safe unsubscribe. */ } };
    } catch { return () => {}; }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      ++this._operationToken;
      const session = this.session;
      const receiver = this.activeReceiver;
      this.connectionState = "idle";
      this.activeReceiver = null;
      this.session = null;
      if (typeof this.adapter?.disconnect === "function" && session) {
        try { Promise.resolve(this.adapter.disconnect(session, receiver)).catch((error) => this._reportError(error)); }
        catch (error) { this._reportError(error); }
      }
      this._persist();
      this.isDestroyed = true;
      this._subscribers.clear();
      this.onChange = null;
      this.onCommand = null;
      this.onError = null;
      this.adapter = null;
      this.storage = null;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; this._subscribers.clear(); return false; }
  }

  _load() {
    try {
      let raw = null;
      if (this.storage) {
        try { raw = this.storage.getItem(this.storageKey); }
        catch (error) { this._reportError(error); }
      }
      if (raw === null || raw === undefined) raw = memoryStorage.get(this.storageKey) ?? null;
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!isRecord(saved)) return;
      if (Array.isArray(saved.receivers)) {
        const unique = new Map();
        for (const candidate of saved.receivers) {
          const receiver = normalizeReceiver(candidate);
          if (receiver) unique.set(receiver.id, receiver);
        }
        this.receivers = [...unique.values()].slice(0, MAX_RECEIVERS);
      }
      if (Array.isArray(saved.commandHistory)) this.commandHistory = saved.commandHistory
        .filter((entry) => isRecord(entry) && COMMAND_TYPES.has(entry.type)).slice(-MAX_COMMANDS).map((entry) => Object.freeze(entry));
      // Sessions are intentionally not restored: transport connections must be re-established by the adapter.
      this.connectionState = "idle";
      this.activeReceiver = null;
      this.session = null;
    } catch (error) { this._reportError(error); }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, receivers: this.receivers, commandHistory: this.commandHistory });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(reason) {
    try {
      const event = Object.freeze({ reason, state: this.getState() });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._subscribers]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
    } catch (error) { this._reportError(error); }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Cast screen operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callbacks. */ }
    } catch { /* Error handling must not interrupt teardown or operations. */ }
  }
}

/** Create a cast controller without requiring browser cast APIs. */
export function createCastScreenController(options = {}) {
  try { return new CastScreenController(options); }
  catch { return null; }
}

export default Object.freeze({ CastScreenController, createCastScreenController, CONNECTION_STATES });
