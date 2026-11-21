const STORAGE_KEY = "trick-a4if-tube:error-boundary-telemetry:v1";
const memoryStorage = new Map();
const DEFAULT_MAX_ERRORS = 500;
const MAX_ERRORS = 10000;
const MAX_TEXT_LENGTH = 10000;
const MAX_CONTEXT_LENGTH = 100000;
const SEVERITIES = Object.freeze(["debug", "info", "warning", "error", "critical"]);

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

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch { return fallback; }
}

function normalizeLimit(value, fallback = DEFAULT_MAX_ERRORS) {
  try {
    if (value === Infinity) return MAX_ERRORS;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_ERRORS, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function normalizeSeverity(value, fallback = "error") {
  try {
    const severity = normalizeText(value, 32).toLowerCase();
    return SEVERITIES.includes(severity) ? severity : fallback;
  } catch { return fallback; }
}

function cloneContext(value) {
  try {
    if (value === null || value === undefined) return {};
    if (!isRecord(value) && !Array.isArray(value)) return { value: normalizeText(value, 2000) };
    const serialized = JSON.stringify(value, (key, item) => {
      if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") return undefined;
      if (typeof item === "number" && !Number.isFinite(item)) return null;
      return item;
    });
    if (typeof serialized !== "string" || serialized.length > MAX_CONTEXT_LENGTH) return {};
    const parsed = JSON.parse(serialized);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
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

function errorParts(input, options = {}) {
  try {
    const settings = isRecord(options) ? options : {};
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        code: input.code,
        stack: input.stack,
        context: settings.context,
      };
    }
    if (isRecord(input)) {
      const sourceError = input.error instanceof Error ? input.error : null;
      return {
        name: input.name ?? input.errorName ?? sourceError?.name,
        message: input.message ?? input.reason ?? input.error?.message ?? sourceError?.message,
        code: input.code ?? input.errorCode ?? input.error?.code ?? sourceError?.code,
        stack: input.stack ?? input.error?.stack ?? sourceError?.stack,
        context: input.context ?? settings.context,
      };
    }
    return { name: settings.name, message: input, code: settings.code, stack: settings.stack, context: settings.context };
  } catch { return { name: "Error", message: "", code: "", stack: "", context: {} }; }
}

function normalizeError(input, options = {}, now = Date.now(), previous = null) {
  try {
    const parts = errorParts(input, options);
    const settings = isRecord(options) ? options : {};
    const name = normalizeText(parts.name ?? settings.name ?? previous?.name, 512) || "Error";
    const message = normalizeText(parts.message ?? settings.message ?? previous?.message, MAX_TEXT_LENGTH) || "Unknown error";
    const timestamp = normalizeTimestamp(settings.timestamp ?? input?.timestamp, now);
    const stack = normalizeText(parts.stack ?? previous?.stack, MAX_TEXT_LENGTH);
    const context = parts.context === undefined && previous ? cloneContext(previous.context) : cloneContext(parts.context);
    return freezeDeep({
      id: normalizeText(settings.id ?? input?.id ?? previous?.id, 512) || "",
      name,
      message,
      code: normalizeText(parts.code ?? settings.code ?? previous?.code, 512),
      severity: normalizeSeverity(settings.severity ?? input?.severity ?? previous?.severity, "error"),
      source: normalizeText(settings.source ?? input?.source ?? previous?.source, 2048),
      stack,
      context,
      timestamp: previous ? previous.timestamp : timestamp,
      lastSeenAt: timestamp,
      count: previous ? previous.count + 1 : 1,
    });
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function freezeList(values) {
  try { return Object.freeze(values.slice()); }
  catch { return Object.freeze([]); }
}

function errorKey(entry) {
  try { return [entry.name, entry.code, entry.message, entry.source].map((part) => normalizeText(part).toLowerCase()).join("\u001f"); }
  catch { return ""; }
}

function normalizeSet(value) {
  try {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return new Set(values.map((item) => normalizeText(item, 2048).toLowerCase()).filter(Boolean));
  } catch { return new Set(); }
}

function matchesError(entry, filter) {
  try {
    if (!isRecord(filter)) return true;
    if (filter.severity !== undefined && !normalizeSet(filter.severity).has(entry.severity.toLowerCase())) return false;
    if (filter.name !== undefined && !normalizeSet(filter.name).has(entry.name.toLowerCase())) return false;
    if (filter.source !== undefined && !normalizeSet(filter.source).has(entry.source.toLowerCase())) return false;
    if (filter.code !== undefined && !normalizeSet(filter.code).has(entry.code.toLowerCase())) return false;
    const from = filter.from ?? filter.since;
    const to = filter.to ?? filter.until;
    if (from != null && entry.lastSeenAt < normalizeTimestamp(from, Infinity)) return false;
    if (to != null && entry.lastSeenAt > normalizeTimestamp(to, -Infinity)) return false;
    const query = normalizeText(filter.query ?? filter.search, 1000).toLowerCase();
    if (query && ![entry.name, entry.message, entry.code, entry.source, entry.stack].some((value) => value.toLowerCase().includes(query))) return false;
    if (typeof filter.predicate === "function" && !filter.predicate(entry)) return false;
    return true;
  } catch { return false; }
}

/**
 * Capture and summarize runtime errors locally. Global listeners are opt-in,
 * and no errors are generated or simulated by this class.
 */
export class ErrorBoundaryTelemetry {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.maxErrors = normalizeLimit(settings.maxErrors ?? settings.limit);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this._errors = [];
      this._listeners = new Set();
      this._globalTarget = null;
      this._errorHandler = null;
      this._rejectionHandler = null;
      this._load();
      if (settings.captureGlobalErrors === true || settings.listenToGlobalErrors === true) this._installGlobalListeners(settings.window);
    } catch (error) {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.maxErrors = DEFAULT_MAX_ERRORS;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this._errors = [];
      this._listeners = new Set();
      this._globalTarget = null;
      this._errorHandler = null;
      this._rejectionHandler = null;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Error telemetry operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate error callbacks. */ }
    } catch { /* Error handling must not interrupt capture or cleanup. */ }
  }

  _installGlobalListeners(candidate) {
    try {
      if (this.isDestroyed || this._globalTarget) return false;
      let target = candidate;
      if (!target) {
        try { target = globalThis.window; } catch { target = null; }
      }
      if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") return false;
      this._globalTarget = target;
      this._errorHandler = (event) => {
        try {
          const detail = event?.error ?? event;
          this.capture(detail, {
            name: detail?.name ?? "Error",
            message: detail?.message ?? event?.message,
            source: event?.filename ?? "window.error",
            context: { type: "window.error", filename: event?.filename ?? "", lineno: event?.lineno ?? 0, colno: event?.colno ?? 0 },
          });
        } catch (error) { this._reportError(error); }
      };
      this._rejectionHandler = (event) => {
        try {
          const reason = event?.reason;
          this.capture(reason, {
            name: reason?.name ?? "UnhandledRejection",
            message: reason?.message ?? (typeof reason === "string" ? reason : "Unhandled promise rejection"),
            source: "window.unhandledrejection",
            context: { type: "unhandledrejection" },
          });
        } catch (error) { this._reportError(error); }
      };
      target.addEventListener("error", this._errorHandler);
      target.addEventListener("unhandledrejection", this._rejectionHandler);
      return true;
    } catch (error) {
      this._reportError(error);
      this._removeGlobalListeners();
      return false;
    }
  }

  _removeGlobalListeners() {
    try {
      if (!this._globalTarget) return true;
      try { if (this._errorHandler) this._globalTarget.removeEventListener("error", this._errorHandler); } catch (error) { this._reportError(error); }
      try { if (this._rejectionHandler) this._globalTarget.removeEventListener("unhandledrejection", this._rejectionHandler); } catch (error) { this._reportError(error); }
      this._globalTarget = null;
      this._errorHandler = null;
      this._rejectionHandler = null;
      return true;
    } catch (error) { this._reportError(error); return false; }
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
      const records = Array.isArray(payload) ? payload : payload?.errors;
      if (!Array.isArray(records)) return false;
      const byKey = new Map();
      for (const candidate of records.slice(-MAX_ERRORS)) {
        const normalized = normalizeError(candidate, { ...candidate, id: candidate?.id }, Date.now());
        if (!normalized) continue;
        const entry = freezeDeep({ ...normalized, timestamp: normalizeTimestamp(candidate.timestamp, normalized.timestamp), lastSeenAt: normalizeTimestamp(candidate.lastSeenAt, normalized.lastSeenAt), count: Math.max(1, Math.floor(Number(candidate.count) || 1)) });
        byKey.set(errorKey(entry), entry);
      }
      this._errors = [...byKey.values()].slice(-this.maxErrors);
      return true;
    } catch (error) { this._reportError(error); this._errors = []; return false; }
  }

  _persist() {
    try {
      const serialized = JSON.stringify({ version: 1, maxErrors: this.maxErrors, errors: this._errors });
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, error = null) {
    try {
      const event = Object.freeze({ type, error: error ?? null, errors: this.getErrors(), summary: this.getSummary() });
      try { this.onChange?.(event, this); } catch (callbackError) { this._reportError(callbackError); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (callbackError) { this._reportError(callbackError); }
      }
      return event;
    } catch (callbackError) { this._reportError(callbackError); return null; }
  }

  /** Capture an Error, error-like object, rejection reason, or message. */
  capture(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxErrors === 0) return null;
      const settings = isRecord(options) ? options : {};
      const initial = normalizeError(input, settings);
      if (!initial) return null;
      const key = errorKey(initial);
      const index = this._errors.findIndex((entry) => errorKey(entry) === key);
      const previous = index >= 0 ? this._errors[index] : null;
      const captured = normalizeError(input, settings, Date.now(), previous);
      if (!captured) return null;
      if (previous) this._errors.splice(index, 1);
      this._errors.push(captured);
      if (this._errors.length > this.maxErrors) this._errors.splice(0, this._errors.length - this.maxErrors);
      this._persist();
      this._notify(previous ? "deduplicated" : "captured", captured);
      return captured;
    } catch (error) { this._reportError(error); return null; }
  }

  record(input, options) { return this.capture(input, options); }
  captureError(input, options) { return this.capture(input, options); }

  getErrors(filter = {}) {
    try {
      if (this.isDestroyed) return Object.freeze([]);
      const settings = typeof filter === "string" ? { query: filter } : (isRecord(filter) ? filter : {});
      let errors = this._errors.filter((entry) => matchesError(entry, settings));
      const order = settings.order === "asc" || settings.ascending === true ? 1 : -1;
      errors.sort((left, right) => order * (left.lastSeenAt - right.lastSeenAt));
      const offsetValue = Number(settings.offset ?? 0);
      const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0;
      const limitValue = settings.limit === undefined ? errors.length : Number(settings.limit);
      const limit = Number.isFinite(limitValue) ? Math.max(0, Math.floor(limitValue)) : errors.length;
      return freezeList(errors.slice(offset, offset + limit));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  query(filter = {}) { return this.getErrors(filter); }
  filter(filter = {}) { return this.getErrors(filter); }
  search(query, options = {}) {
    try { return this.getErrors({ ...(isRecord(options) ? options : {}), query }); }
    catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  getError(id) {
    try { return this._errors.find((entry) => entry.id && entry.id === normalizeText(id, 512)) ?? null; }
    catch { return null; }
  }

  /** Summarize distinct retained errors, event counts, severity, and recency. */
  getSummary(filter = {}) {
    try {
      const errors = this.getErrors(filter);
      const countsBySeverity = Object.create(null);
      const countsByName = Object.create(null);
      const countsBySource = Object.create(null);
      let occurrenceCount = 0;
      for (const entry of errors) {
        countsBySeverity[entry.severity] = (countsBySeverity[entry.severity] ?? 0) + 1;
        countsByName[entry.name] = (countsByName[entry.name] ?? 0) + 1;
        const source = entry.source || "(unknown)";
        countsBySource[source] = (countsBySource[source] ?? 0) + 1;
        occurrenceCount += entry.count;
      }
      const mostRecent = errors.reduce((latest, entry) => !latest || entry.lastSeenAt > latest.lastSeenAt ? entry : latest, null);
      return Object.freeze({
        errorCount: errors.length,
        occurrenceCount,
        countsBySeverity: Object.freeze({ ...countsBySeverity }),
        countsByName: Object.freeze({ ...countsByName }),
        countsBySource: Object.freeze({ ...countsBySource }),
        mostRecent,
        firstSeenAt: errors.length ? Math.min(...errors.map((entry) => entry.timestamp)) : null,
        lastSeenAt: mostRecent?.lastSeenAt ?? null,
        maxErrors: this.maxErrors,
      });
    } catch (error) {
      this._reportError(error);
      return Object.freeze({ errorCount: 0, occurrenceCount: 0, countsBySeverity: Object.freeze({}), countsByName: Object.freeze({}), countsBySource: Object.freeze({}), mostRecent: null, firstSeenAt: null, lastSeenAt: null, maxErrors: this.maxErrors });
    }
  }

  summary(filter = {}) { return this.getSummary(filter); }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      const removed = this._errors.length;
      this._errors = [];
      if (isRecord(options) && options.removeStorage === true) {
        memoryStorage.delete(this.storageKey);
        try { this.storage?.removeItem?.(this.storageKey); } catch (error) { this._reportError(error); }
      } else this._persist();
      this._notify("cleared", null);
      return removed >= 0;
    } catch (error) { this._reportError(error); return false; }
  }

  setMaxErrors(value) {
    try {
      if (this.isDestroyed) return false;
      const capacity = normalizeLimit(value, -1);
      if (capacity < 0) return false;
      this.maxErrors = capacity;
      if (this._errors.length > capacity) this._errors.splice(0, this._errors.length - capacity);
      this._persist();
      this._notify("capacity-changed");
      return true;
    } catch (error) { this._reportError(error); return false; }
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
      const payload = { version: 1, exportedAt: Date.now(), maxErrors: this.maxErrors, errors: this.getErrors({ order: "asc" }) };
      return settings.asObject === true ? freezeDeep(payload) : JSON.stringify(payload, null, settings.pretty === false ? 0 : 2);
    } catch (error) { this._reportError(error); return ""; }
  }

  importJSON(input, options = {}) {
    try {
      if (this.isDestroyed) return 0;
      const settings = isRecord(options) ? options : {};
      let payload = input;
      if (typeof input === "string") payload = JSON.parse(input);
      if (Array.isArray(payload)) payload = { errors: payload };
      if (!isRecord(payload) || !Array.isArray(payload.errors ?? payload.entries)) return 0;
      const records = payload.errors ?? payload.entries;
      const next = settings.replace === true ? [] : this._errors.slice();
      const indexes = new Map(next.map((entry, index) => [errorKey(entry), index]));
      let imported = 0;
      for (const candidate of records.slice(-MAX_ERRORS)) {
        const normalized = normalizeError(candidate, candidate, normalizeTimestamp(candidate?.lastSeenAt ?? candidate?.timestamp));
        if (!normalized) continue;
        const key = errorKey(normalized);
        const previousIndex = indexes.get(key);
        if (previousIndex !== undefined && settings.dedupe !== false) {
          const previous = next[previousIndex];
          next[previousIndex] = freezeDeep({ ...normalized, timestamp: Math.min(previous.timestamp, normalized.timestamp), lastSeenAt: Math.max(previous.lastSeenAt, normalized.lastSeenAt), count: previous.count + normalized.count });
        } else {
          indexes.set(key, next.length);
          next.push(normalized);
        }
        imported += 1;
      }
      this._errors = next.slice(-this.maxErrors);
      this._persist();
      if (settings.silent !== true && (imported > 0 || settings.replace === true)) this._notify("imported");
      return imported;
    } catch (error) { this._reportError(error); return 0; }
  }

  get size() { try { return this._errors.length; } catch { return 0; } }
  get count() { return this.size; }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._removeGlobalListeners();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create error telemetry safely, including when browser storage is restricted. */
export function createErrorBoundaryTelemetry(options = {}) {
  try { return new ErrorBoundaryTelemetry(options); }
  catch { return null; }
}

export { SEVERITIES };

export default Object.freeze({ ErrorBoundaryTelemetry, createErrorBoundaryTelemetry, SEVERITIES });
