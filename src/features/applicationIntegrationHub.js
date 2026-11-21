import { FeatureRegistryHub, createFeatureRegistryHub } from "./featureRegistryHub.js";

const STORAGE_KEY = "trick-a4if-tube:application-integration-hub:v1";
const memoryStorage = new Map();
const MAX_INTEGRATIONS = 1000;
const MAX_TEXT_LENGTH = 4096;
const LIFECYCLE_STATES = Object.freeze(["idle", "initializing", "ready", "degraded", "destroyed"]);

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

function normalizeLimit(value, fallback = MAX_INTEGRATIONS) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_INTEGRATIONS, Math.max(0, Math.floor(number))) : fallback;
  } catch { return fallback; }
}

function cloneJSON(value, fallback = {}) {
  try {
    const serialized = JSON.stringify(value, (key, entry) => {
      if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") return undefined;
      if (typeof entry === "number" && !Number.isFinite(entry)) return null;
      return entry;
    });
    if (typeof serialized !== "string" || serialized.length > 100000) return fallback;
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch { return fallback; }
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

function normalizeState(value, fallback = "idle") {
  try {
    const state = normalizeText(value, 32).toLowerCase();
    return LIFECYCLE_STATES.includes(state) ? state : fallback;
  } catch { return fallback; }
}

function normalizeIntegration(input, now = Date.now()) {
  try {
    if (!isRecord(input)) return null;
    const name = normalizeText(input.name ?? input.id, 512);
    const source = normalizeText(input.source ?? input.from, 512);
    const target = normalizeText(input.target ?? input.to, 512);
    if (!name || (!source && !target)) return null;
    return {
      name,
      source,
      target,
      event: normalizeText(input.event ?? input.eventName, 256),
      method: normalizeText(input.method ?? input.targetMethod ?? input.callbackMethod, 256),
      enabled: input.enabled !== false,
      metadata: cloneJSON(input.metadata, {}),
      createdAt: normalizeTimestamp(input.createdAt, now),
      updatedAt: now,
      handler: typeof input.handler === "function" ? input.handler : null,
      transform: typeof input.transform === "function" ? input.transform : null,
    };
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function describeIntegration(item) {
  try {
    return Object.freeze({ name: item.name, source: item.source, target: item.target, event: item.event, method: item.method, enabled: item.enabled, metadata: freezeDeep(cloneJSON(item.metadata)), createdAt: item.createdAt, updatedAt: item.updatedAt, connected: Boolean(item.unsubscribe), lastError: item.lastError ?? null, lastInvokedAt: item.lastInvokedAt ?? null, invocationCount: item.invocationCount ?? 0 });
  } catch { return null; }
}

/**
 * Connect caller-provided feature modules through a FeatureRegistryHub. Wiring
 * is opt-in and explicit; the hub does not fabricate modules or perform I/O.
 */
export class ApplicationIntegrationHub {
  constructor(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      this.storage = resolveStorage(settings.storage);
      this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
      this.registry = settings.registry instanceof FeatureRegistryHub
        ? settings.registry
        : (settings.registry && typeof settings.registry.getInstance === "function" && typeof settings.registry.list === "function"
          ? settings.registry : createFeatureRegistryHub({ storage: settings.registryStorage, storageKey: settings.registryStorageKey }));
      this.ownsRegistry = !(settings.registry && this.registry === settings.registry);
      this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
      this.onError = typeof settings.onError === "function" ? settings.onError : null;
      this.lastError = null;
      this.isDestroyed = false;
      this.state = "idle";
      this._integrations = new Map();
      this._listeners = new Set();
      this._registryUnsubscribe = null;
      this._load();
      if (Array.isArray(settings.modules)) {
        for (const module of settings.modules) this.registerModule(module, { silent: true });
      }
      if (Array.isArray(settings.integrations)) {
        for (const integration of settings.integrations) this.wire(integration, { silent: true, defer: true });
      }
      if (settings.autoInitialize === true) this.initialize();
    } catch (error) {
      this.storage = null;
      this.storageKey = STORAGE_KEY;
      this.registry = null;
      this.ownsRegistry = false;
      this.onChange = null;
      this.onError = null;
      this.lastError = error instanceof Error ? error : null;
      this.isDestroyed = false;
      this.state = "idle";
      this._integrations = new Map();
      this._listeners = new Set();
      this._registryUnsubscribe = null;
    }
  }

  _reportError(error, integration = "") {
    try {
      this.lastError = error instanceof Error ? error : new Error("Application integration operation failed.");
      try { this.onError?.(this.lastError, this, normalizeText(integration, 512) || null); } catch { /* Keep error handlers isolated. */ }
    } catch { /* Reporting cannot interrupt integration handling. */ }
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
      if (!isRecord(payload)) return false;
      this.state = normalizeState(payload.state, "idle");
      for (const candidate of (Array.isArray(payload.integrations) ? payload.integrations : []).slice(0, MAX_INTEGRATIONS)) {
        const integration = normalizeIntegration(candidate);
        if (integration) this._integrations.set(integration.name, { ...integration, unsubscribe: null, lastError: null, lastInvokedAt: null, invocationCount: 0 });
      }
      // A persisted runtime state is informational only; startup always begins idle.
      if (this.state === "destroyed" || this.state === "initializing") this.state = "idle";
      return true;
    } catch (error) { this._reportError(error); this.state = "idle"; this._integrations.clear(); return false; }
  }

  _persist() {
    try {
      const payload = {
        version: 1,
        state: this.state,
        updatedAt: Date.now(),
        integrations: [...this._integrations.values()].map(({ handler, transform, unsubscribe, lastError, lastInvokedAt, invocationCount, ...item }) => ({ ...item, lastError: lastError ? normalizeText(lastError.message, 1000) : "", lastInvokedAt, invocationCount })),
      };
      const serialized = JSON.stringify(payload);
      memoryStorage.set(this.storageKey, serialized);
      if (this.storage) {
        try { this.storage.setItem(this.storageKey, serialized); }
        catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, detail = {}) {
    try {
      const event = Object.freeze({ type, state: this.state, report: this.getIntegrationReport(), ...detail });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _setState(state, options = {}) {
    try {
      const next = normalizeState(state, this.state);
      if (next === this.state) return true;
      const previous = this.state;
      this.state = next;
      if (options.persist !== false) this._persist();
      if (options.silent !== true) this._notify("lifecycle", { previousState: previous });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  /** Register a module using this hub's registry. */
  registerModule(input, options = {}) {
    try {
      if (this.isDestroyed || !this.registry || !isRecord(input)) return null;
      const descriptor = input.instance !== undefined ? input : { ...input, instance: input.module ?? input.feature };
      const registered = this.registry.register(descriptor, options);
      if (!registered) return null;
      this._notify("module-registered", { moduleName: registered.name });
      return registered;
    } catch (error) { this._reportError(error, input?.name); return null; }
  }

  register(input, options) { return this.registerModule(input, options); }

  getModule(name) {
    try { return this.registry?.getInstance?.(normalizeText(name, 512)) ?? null; }
    catch (error) { this._reportError(error, name); return null; }
  }

  /** Create or replace an explicit source-event to target-method connection. */
  wire(input, options = {}) {
    try {
      if (this.isDestroyed || !isRecord(input)) return null;
      const settings = isRecord(options) ? options : {};
      const integration = normalizeIntegration(input);
      if (!integration) return null;
      const existing = this._integrations.get(integration.name);
      if (existing?.unsubscribe) this._safeUnsubscribe(existing);
      integration.createdAt = existing?.createdAt ?? integration.createdAt;
      const record = { ...integration, unsubscribe: null, lastError: null, lastInvokedAt: null, invocationCount: 0 };
      this._integrations.set(record.name, record);
      if (settings.defer !== true && record.enabled && this.state !== "destroyed") this._connect(record);
      this._persist();
      if (settings.silent !== true) this._notify(existing ? "integration-updated" : "integration-wired", { integration: describeIntegration(record) });
      return describeIntegration(record);
    } catch (error) { this._reportError(error, input?.name); return null; }
  }

  registerIntegration(input, options) { return this.wire(input, options); }

  _connect(record) {
    try {
      if (this.isDestroyed || !record.enabled || record.unsubscribe) return Boolean(record.unsubscribe);
      const source = this.getModule(record.source);
      if (!source) throw new Error(`Source module '${record.source}' is not registered.`);
      const callback = (...args) => this._dispatch(record, args);
      let result;
      if (typeof source.subscribe === "function") result = source.subscribe(callback);
      else if (typeof source.subscribeToChanges === "function") result = source.subscribeToChanges(callback);
      else if (typeof source.on === "function" && record.event) {
        source.on(record.event, callback);
        result = () => source.off?.(record.event, callback) ?? source.removeListener?.(record.event, callback);
      } else if (typeof source.addEventListener === "function" && record.event) {
        source.addEventListener(record.event, callback);
        result = () => source.removeEventListener?.(record.event, callback);
      } else throw new Error(`Source module '${record.source}' does not expose a compatible subscription API.`);
      if (typeof result === "function") record.unsubscribe = result;
      else if (result && typeof result.unsubscribe === "function") record.unsubscribe = () => result.unsubscribe();
      else if (typeof source.unsubscribe === "function") record.unsubscribe = () => source.unsubscribe(callback);
      else record.unsubscribe = () => {};
      record.lastError = null;
      return true;
    } catch (error) {
      record.lastError = error instanceof Error ? error : new Error("Integration connection failed.");
      this._reportError(record.lastError, record.name);
      return false;
    }
  }

  _dispatch(record, args) {
    try {
      if (this.isDestroyed || !record.enabled) return false;
      const target = this.getModule(record.target);
      if (!target) throw new Error(`Target module '${record.target}' is not registered.`);
      let payload = args.length <= 1 ? args[0] : args;
      if (record.transform) payload = record.transform(payload, Object.freeze({ integration: describeIntegration(record), hub: this }));
      if (record.handler) {
        record.handler(payload, Object.freeze({ integration: describeIntegration(record), source: this.getModule(record.source), target, hub: this }));
      } else {
        const method = record.method && target[record.method];
        if (typeof method !== "function") throw new Error(`Target method '${record.method}' is unavailable on '${record.target}'.`);
        method.call(target, payload, Object.freeze({ integration: record.name, source: record.source }));
      }
      record.lastError = null;
      record.lastInvokedAt = Date.now();
      record.invocationCount += 1;
      return true;
    } catch (error) {
      record.lastError = error instanceof Error ? error : new Error("Integration callback failed.");
      this._reportError(record.lastError, record.name);
      return false;
    }
  }

  _safeUnsubscribe(record) {
    try {
      const unsubscribe = record?.unsubscribe;
      record.unsubscribe = null;
      if (typeof unsubscribe === "function") unsubscribe();
      return true;
    } catch (error) { this._reportError(error, record?.name); return false; }
  }

  enableIntegration(name) {
    try {
      if (this.isDestroyed) return false;
      const record = this._integrations.get(normalizeText(name, 512));
      if (!record) return false;
      record.enabled = true;
      record.updatedAt = Date.now();
      const connected = this._connect(record);
      this._persist();
      this._notify("integration-enabled", { integration: describeIntegration(record) });
      return connected;
    } catch (error) { this._reportError(error, name); return false; }
  }

  disableIntegration(name) {
    try {
      if (this.isDestroyed) return false;
      const record = this._integrations.get(normalizeText(name, 512));
      if (!record) return false;
      record.enabled = false;
      record.updatedAt = Date.now();
      this._safeUnsubscribe(record);
      this._persist();
      this._notify("integration-disabled", { integration: describeIntegration(record) });
      return true;
    } catch (error) { this._reportError(error, name); return false; }
  }

  removeIntegration(name) {
    try {
      if (this.isDestroyed) return false;
      const key = normalizeText(name, 512);
      const record = this._integrations.get(key);
      if (!record) return false;
      this._safeUnsubscribe(record);
      this._integrations.delete(key);
      this._persist();
      this._notify("integration-removed", { integration: describeIntegration(record) });
      return true;
    } catch (error) { this._reportError(error, name); return false; }
  }

  getIntegrations(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let list = [...this._integrations.values()];
      if (typeof settings.enabled === "boolean") list = list.filter((item) => item.enabled === settings.enabled);
      const query = normalizeText(settings.query ?? settings.search, 1000).toLowerCase();
      if (query) list = list.filter((item) => [item.name, item.source, item.target, item.event, item.method].some((value) => value.toLowerCase().includes(query)));
      list.sort((a, b) => a.name.localeCompare(b.name));
      return Object.freeze(list.map(describeIntegration).filter(Boolean));
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  /** Connect deferred integrations and optionally call module initialization hooks. */
  initialize(options = {}) {
    try {
      if (this.isDestroyed) return Object.freeze({ state: "destroyed", ready: false, results: Object.freeze([]) });
      const settings = isRecord(options) ? options : {};
      this._setState("initializing", { silent: settings.silent === true });
      const results = [];
      for (const entry of (this.registry?.list?.({ enabled: true, includeInstances: true }) ?? [])) {
        const module = entry.instance;
        if (module && typeof module.initialize === "function" && settings.initializeModules !== false) {
          try {
            const result = module.initialize();
            results.push({ name: entry.name, ok: !(result === false), result: result === undefined ? null : result });
          } catch (error) {
            this._reportError(error, entry.name);
            results.push({ name: entry.name, ok: false, error: normalizeText(error?.message, 1000) });
          }
        }
      }
      for (const integration of this._integrations.values()) {
        if (!integration.enabled) continue;
        const ok = this._connect(integration);
        results.push({ name: integration.name, ok, kind: "integration", ...(integration.lastError ? { error: normalizeText(integration.lastError.message, 1000) } : {}) });
      }
      const degraded = results.some((result) => !result.ok);
      this._setState(degraded ? "degraded" : "ready", { silent: settings.silent === true });
      const report = Object.freeze({ state: this.state, ready: this.state === "ready", results: freezeRecords(results) });
      this._persist();
      if (settings.silent !== true) this._notify("initialized", { result: report });
      return report;
    } catch (error) {
      this._reportError(error);
      this._setState("degraded");
      return Object.freeze({ state: this.state, ready: false, results: Object.freeze([]), error: normalizeText(error?.message, 1000) });
    }
  }

  /** Run explicit or inferred health checks; supports asynchronous check methods. */
  runHealthCheck(options = {}) {
    try {
      if (this.isDestroyed) return Object.freeze({ state: "destroyed", ready: false, healthy: false, modules: Object.freeze([]), integrations: Object.freeze([]) });
      const settings = isRecord(options) ? options : {};
      const moduleReports = [];
      const registryReport = this.registry?.getHealthReport?.() ?? null;
      const entries = this.registry?.list?.({ includeInstances: true }) ?? [];
      for (const entry of entries) {
        if (settings.includeDisabled !== true && !entry.enabled) {
          moduleReports.push(Object.freeze({ name: entry.name, status: "disabled", healthy: true, ready: false }));
          continue;
        }
        const module = entry.instance;
        const check = typeof settings.moduleCheck === "function" ? () => settings.moduleCheck(module, entry)
          : typeof module?.runHealthCheck === "function" ? () => module.runHealthCheck()
            : typeof module?.healthCheck === "function" ? () => module.healthCheck()
              : typeof module?.isHealthy === "function" ? () => module.isHealthy() : null;
        if (!check) {
          const status = module?.isDestroyed === true ? "destroyed" : (module ? "healthy" : "missing-instance");
          moduleReports.push(Object.freeze({ name: entry.name, status, healthy: status === "healthy" || status === "disabled", ready: status === "healthy" }));
          continue;
        }
        let result;
        try { result = check(); }
        catch (error) {
          this._reportError(error, entry.name);
          moduleReports.push(Object.freeze({ name: entry.name, status: "error", healthy: false, ready: false, error: normalizeText(error?.message, 1000) }));
          continue;
        }
        if (result && typeof result.then === "function") {
          moduleReports.push(result.then((value) => normalizeModuleCheck(entry.name, value)).catch((error) => {
            this._reportError(error, entry.name);
            return Object.freeze({ name: entry.name, status: "error", healthy: false, ready: false, error: normalizeText(error?.message, 1000) });
          }));
        } else moduleReports.push(normalizeModuleCheck(entry.name, result));
      }
      const integrations = this.getIntegrations().map((integration) => Object.freeze({
        ...integration,
        healthy: integration.enabled ? integration.connected && !integration.lastError : true,
        ready: integration.enabled && integration.connected,
        status: !integration.enabled ? "disabled" : integration.connected ? (integration.lastError ? "error" : "healthy") : "disconnected",
      }));
      const finish = (modules) => {
        const moduleList = freezeRecords(modules);
        const healthy = moduleList.every((item) => item.healthy) && integrations.every((item) => item.healthy);
        const ready = moduleList.every((item) => item.ready) && integrations.every((item) => item.ready || !item.enabled);
        const state = !healthy ? "degraded" : ready ? "ready" : "idle";
        if (this.state !== "initializing" && state !== "idle") this._setState(state, { silent: settings.silent === true });
        const report = Object.freeze({ checkedAt: Date.now(), state: this.state, ready, healthy, moduleCount: moduleList.length, integrationCount: integrations.length, modules: moduleList, integrations: Object.freeze(integrations), registry: registryReport });
        if (settings.silent !== true) this._notify("health-check", { result: report });
        return report;
      };
      return moduleReports.some((result) => result && typeof result.then === "function")
        ? Promise.all(moduleReports).then(finish)
        : finish(moduleReports);
    } catch (error) {
      this._reportError(error);
      return Object.freeze({ checkedAt: Date.now(), state: "degraded", ready: false, healthy: false, moduleCount: 0, integrationCount: 0, modules: Object.freeze([]), integrations: Object.freeze([]), registry: null, error: normalizeText(error?.message, 1000) });
    }
  }

  getIntegrationReport(options = {}) {
    try {
      const modules = this.registry?.inspectAll?.() ?? Object.freeze([]);
      const integrations = this.getIntegrations(options).map((integration) => Object.freeze({ ...integration, status: !integration.enabled ? "disabled" : integration.connected ? (integration.lastError ? "error" : "connected") : "disconnected", healthy: !integration.enabled || (integration.connected && !integration.lastError) }));
      const healthy = modules.filter((item) => item.enabled).every((item) => item.healthy) && integrations.every((item) => item.healthy);
      const ready = this.state === "ready" && integrations.filter((item) => item.enabled).every((item) => item.connected) && modules.filter((item) => item.enabled).every((item) => item.healthy);
      return Object.freeze({ state: this.state, ready, healthy, generatedAt: Date.now(), moduleCount: modules.length, integrationCount: integrations.length, modules, integrations });
    } catch (error) {
      this._reportError(error);
      return Object.freeze({ state: this.state, ready: false, healthy: false, generatedAt: Date.now(), moduleCount: 0, integrationCount: 0, modules: Object.freeze([]), integrations: Object.freeze([]) });
    }
  }

  getStatus() {
    try { return Object.freeze({ state: this.state, isDestroyed: this.isDestroyed, moduleCount: this.registry?.size ?? 0, integrationCount: this._integrations.size }); }
    catch { return Object.freeze({ state: "idle", isDestroyed: false, moduleCount: 0, integrationCount: 0 }); }
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

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      const settings = isRecord(options) ? options : {};
      for (const integration of this._integrations.values()) this._safeUnsubscribe(integration);
      if (this._registryUnsubscribe) {
        try { this._registryUnsubscribe(); } catch (error) { this._reportError(error); }
        this._registryUnsubscribe = null;
      }
      if (settings.destroyModules === true) {
        const result = this.registry?.destroyAll?.({ unregister: settings.unregisterModules === true, silent: true });
        if (result && typeof result.then === "function") return result.finally(() => this._finishDestroy(settings));
      }
      return this._finishDestroy(settings);
    } catch (error) { this._reportError(error); return this._finishDestroy({}); }
  }

  _finishDestroy(options = {}) {
    try {
      this.state = "destroyed";
      this._persist();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      if (options.destroyRegistry === true && this.ownsRegistry) {
        try { this.registry?.destroy?.({ clear: options.clearRegistry === true }); } catch (error) { this._reportError(error); }
      }
      this.isDestroyed = true;
      return true;
    } catch (error) { this.isDestroyed = true; return false; }
  }
}

function normalizeModuleCheck(name, result) {
  try {
    if (result === false) return Object.freeze({ name, status: "unhealthy", healthy: false, ready: false });
    if (result === true || result == null) return Object.freeze({ name, status: "healthy", healthy: true, ready: true });
    if (isRecord(result)) {
      const healthy = result.healthy !== false && result.ok !== false && result.status !== "error" && result.status !== "unhealthy";
      const ready = result.ready !== false && healthy;
      return Object.freeze({ name, ...cloneJSON(result), status: normalizeText(result.status, 64) || (healthy ? "healthy" : "unhealthy"), healthy, ready });
    }
    return Object.freeze({ name, status: "healthy", healthy: true, ready: true, result: normalizeText(result, 512) });
  } catch { return Object.freeze({ name, status: "unknown", healthy: false, ready: false }); }
}

function freezeRecords(values) {
  try { return Object.freeze(values.map((value) => isRecord(value) ? Object.freeze(value) : value)); }
  catch { return Object.freeze([]); }
}

/** Safely create an application integration hub. */
export function createApplicationIntegrationHub(options = {}) {
  try { return new ApplicationIntegrationHub(options); }
  catch { return null; }
}

export { LIFECYCLE_STATES };

export default Object.freeze({ ApplicationIntegrationHub, createApplicationIntegrationHub, LIFECYCLE_STATES });
