const STORAGE_KEY = "trick-a4if-tube:data-usage";
const NETWORK_TYPES = Object.freeze(["wifi", "cellular", "ethernet", "unknown"]);
const DEFAULT_WARNING_THRESHOLDS = Object.freeze([0.5, 0.8, 0.95]);
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = 512) {
  try { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
  catch { return ""; }
}

function nonNegative(value, fallback = null) {
  try {
    if (value === "" || value == null) return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  } catch { return fallback; }
}

function normalizeNetworkType(value) {
  try {
    const type = normalizeText(value, 32).toLowerCase();
    return NETWORK_TYPES.includes(type) ? type : "unknown";
  } catch { return "unknown"; }
}

function normalizeDateKey(value, fallback = new Date().toISOString().slice(0, 10)) {
  try {
    const text = normalizeText(value, 32);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : fallback;
  } catch { return fallback; }
}

function createCounters() {
  return { totalBytes: 0, byNetwork: { wifi: 0, cellular: 0, ethernet: 0, unknown: 0 }, byVideo: {}, byCategory: {} };
}

function normalizeCounters(input) {
  try {
    const counters = createCounters();
    if (!isRecord(input)) return counters;
    counters.totalBytes = nonNegative(input.totalBytes, 0);
    if (isRecord(input.byNetwork)) {
      for (const type of NETWORK_TYPES) counters.byNetwork[type] = nonNegative(input.byNetwork[type], 0);
    }
    for (const field of ["byVideo", "byCategory"]) {
      if (!isRecord(input[field])) continue;
      for (const [key, bytes] of Object.entries(input[field])) {
        const normalizedKey = normalizeText(key, 512);
        const count = nonNegative(bytes, null);
        if (normalizedKey && count !== null) counters[field][normalizedKey] = count;
      }
    }
    return counters;
  } catch { return createCounters(); }
}

function normalizeThresholds(value) {
  try {
    const values = Array.isArray(value) ? value : DEFAULT_WARNING_THRESHOLDS;
    return Object.freeze([...new Set(values.map(Number).filter((number) => Number.isFinite(number) && number > 0 && number <= 1))].sort((a, b) => a - b));
  } catch { return DEFAULT_WARNING_THRESHOLDS; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function cloneCounters(counters) {
  try {
    return {
      totalBytes: counters.totalBytes,
      byNetwork: { ...counters.byNetwork },
      byVideo: { ...counters.byVideo },
      byCategory: { ...counters.byCategory },
    };
  } catch { return createCounters(); }
}

/** Format a byte count using binary units by default (KiB, MiB, GiB). */
export function formatBytes(value, options = {}) {
  try {
    const bytes = nonNegative(value, null);
    if (bytes === null) return "0 B";
    const settings = isRecord(options) ? options : {};
    const base = settings.decimal === true ? 1000 : 1024;
    const units = settings.decimal === true
      ? ["B", "kB", "MB", "GB", "TB", "PB"]
      : ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    if (bytes < base) return `${Math.round(bytes)} B`;
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(base)));
    const amount = bytes / (base ** exponent);
    const decimals = Number.isInteger(amount) ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(decimals)} ${units[exponent]}`;
  } catch { return "0 B"; }
}

/**
 * Track actual byte counts supplied by the caller. No network activity is
 * measured or simulated by this class. Daily counters use UTC date keys.
 */
export class DataUsageTracker {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.dataCapBytes = nonNegative(settings.dataCapBytes ?? settings.dataCap, null);
    this.warningThresholds = normalizeThresholds(settings.warningThresholds);
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onWarning = typeof settings.onWarning === "function" ? settings.onWarning : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._listeners = new Set();
    this._session = createCounters();
    this._daily = Object.create(null);
    this._allTime = createCounters();
    this._load();
    this.sessionStartedAt = Date.now();
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Data usage tracking operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callback errors. */ }
    } catch { /* Reporting never interrupts tracking. */ }
  }

  _load() {
    try {
      let serialized = null;
      try { serialized = this.storage?.getItem(this.storageKey); }
      catch (error) { this._reportError(error); }
      if (typeof serialized !== "string" || !serialized) return false;
      const parsed = JSON.parse(serialized);
      if (!isRecord(parsed)) return false;
      this._allTime = normalizeCounters(parsed.allTime);
      this._daily = Object.create(null);
      if (isRecord(parsed.daily)) {
        for (const [day, counters] of Object.entries(parsed.daily)) {
          const key = normalizeDateKey(day, "");
          if (key) this._daily[key] = normalizeCounters(counters);
        }
      }
      // A session is intentionally new for each manager lifetime.
      this._session = createCounters();
      return true;
    } catch (error) {
      this._reportError(error);
      this._allTime = createCounters();
      this._daily = Object.create(null);
      return false;
    }
  }

  _persist() {
    try {
      if (!this.storage || typeof this.storage.setItem !== "function") return false;
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, allTime: this._allTime, daily: this._daily }));
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _snapshot() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      return Object.freeze({
        dataCapBytes: this.dataCapBytes,
        sessionStartedAt: this.sessionStartedAt,
        session: Object.freeze(cloneCounters(this._session)),
        today: Object.freeze(cloneCounters(this._daily[today] ?? createCounters())),
        daily: Object.freeze(Object.fromEntries(Object.entries(this._daily).map(([key, value]) => [key, Object.freeze(cloneCounters(value))]))),
        allTime: Object.freeze(cloneCounters(this._allTime)),
      });
    } catch { return null; }
  }

  _notify(type, detail = {}) {
    try {
      const event = Object.freeze({ type, snapshot: this._snapshot(), ...detail });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _increment(counters, bytes, networkType, videoId, category) {
    try {
      counters.totalBytes += bytes;
      counters.byNetwork[networkType] = (counters.byNetwork[networkType] ?? 0) + bytes;
      if (videoId) counters.byVideo[videoId] = (counters.byVideo[videoId] ?? 0) + bytes;
      if (category) counters.byCategory[category] = (counters.byCategory[category] ?? 0) + bytes;
    } catch (error) { this._reportError(error); }
  }

  /** Record actual bytes transferred; returns false for invalid input. */
  record(bytesOrEntry, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const entry = isRecord(bytesOrEntry) ? bytesOrEntry : { ...(isRecord(options) ? options : {}), bytes: bytesOrEntry };
      const bytes = nonNegative(entry.bytes ?? entry.byteCount ?? entry.transferredBytes ?? entry.sizeBytes, null);
      if (bytes === null) return false;
      const networkType = normalizeNetworkType(entry.networkType ?? entry.network ?? entry.connectionType);
      const videoId = normalizeText(entry.videoId ?? entry.video ?? entry.id, 512);
      const category = normalizeText(entry.category, 512);
      const timestamp = nonNegative(entry.timestamp, Date.now());
      const day = normalizeDateKey(new Date(timestamp).toISOString().slice(0, 10));
      const daily = this._daily[day] ?? (this._daily[day] = createCounters());
      this._increment(this._session, bytes, networkType, videoId, category);
      this._increment(daily, bytes, networkType, videoId, category);
      this._increment(this._allTime, bytes, networkType, videoId, category);
      this._persist();
      const event = this._notify("record", { bytes, networkType, videoId: videoId || null, category: category || null, timestamp, day });
      this._checkWarnings();
      return event ?? true;
    } catch (error) { this._reportError(error); return false; }
  }

  recordUsage(bytesOrEntry, options) { return this.record(bytesOrEntry, options); }
  recordBytes(bytes, options) { return this.record(bytes, options); }

  _checkWarnings() {
    try {
      if (this.dataCapBytes === null || this.dataCapBytes <= 0) return;
      const ratio = this._allTime.totalBytes / this.dataCapBytes;
      const threshold = this.warningThresholds.find((value) => ratio >= value);
      if (threshold !== undefined) {
        const detail = Object.freeze({ threshold, ratio, usedBytes: this._allTime.totalBytes, dataCapBytes: this.dataCapBytes, remainingBytes: Math.max(0, this.dataCapBytes - this._allTime.totalBytes) });
        try { this.onWarning?.(detail, this); } catch (error) { this._reportError(error); }
        this._notify("warning", detail);
      }
    } catch (error) { this._reportError(error); }
  }

  setDataCap(value) {
    try {
      if (this.isDestroyed) return false;
      const cap = value == null ? null : nonNegative(value, null);
      if (value != null && cap === null) return false;
      this.dataCapBytes = cap;
      this._notify("cap-change", { dataCapBytes: cap });
      this._checkWarnings();
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  getUsage(scope = "allTime", options = {}) {
    try {
      const name = normalizeText(scope, 32).toLowerCase();
      let counters;
      if (name === "session") counters = this._session;
      else if (name === "today" || name === "daily") {
        const day = normalizeDateKey(options?.date);
        counters = this._daily[day] ?? createCounters();
      } else if (name === "alltime" || name === "all-time" || name === "total") counters = this._allTime;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(name)) counters = this._daily[name] ?? createCounters();
      else return null;
      return Object.freeze(cloneCounters(counters));
    } catch (error) { this._reportError(error); return null; }
  }

  getVideoUsage(videoId, scope = "allTime") {
    try {
      const id = normalizeText(videoId, 512);
      const counters = this.getUsage(scope);
      return id && counters ? nonNegative(counters.byVideo[id], 0) : 0;
    } catch { return 0; }
  }

  getCategoryUsage(category, scope = "allTime") {
    try {
      const key = normalizeText(category, 512);
      const counters = this.getUsage(scope);
      return key && counters ? nonNegative(counters.byCategory[key], 0) : 0;
    } catch { return 0; }
  }

  getNetworkUsage(networkType, scope = "allTime") {
    try {
      const type = normalizeNetworkType(networkType);
      const counters = this.getUsage(scope);
      return counters ? nonNegative(counters.byNetwork[type], 0) : 0;
    } catch { return 0; }
  }

  getCapStatus() {
    try {
      const usedBytes = this._allTime.totalBytes;
      const capBytes = this.dataCapBytes;
      return Object.freeze({
        capBytes,
        usedBytes,
        remainingBytes: capBytes === null ? null : Math.max(0, capBytes - usedBytes),
        ratio: capBytes === null || capBytes === 0 ? null : usedBytes / capBytes,
        exceeded: capBytes !== null && usedBytes >= capBytes,
      });
    } catch { return null; }
  }

  reset(scope = "all", options = {}) {
    try {
      if (this.isDestroyed) return false;
      const target = normalizeText(scope, 32).toLowerCase();
      if (target === "session" || target === "all") this._session = createCounters();
      if (target === "daily" || target === "today" || target === "all") {
        if (isRecord(options) && options.date) {
          delete this._daily[normalizeDateKey(options.date)];
        } else if (target === "all" || target === "daily") {
          this._daily = Object.create(null);
        } else {
          delete this._daily[new Date().toISOString().slice(0, 10)];
        }
      }
      if (target === "alltime" || target === "all-time" || target === "all") this._allTime = createCounters();
      if (!["session", "daily", "today", "alltime", "all-time", "all"].includes(target)) return false;
      this._persist();
      this._notify("reset", { scope: target, date: options?.date ?? null });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  resetSession() { return this.reset("session"); }
  resetDaily(date) { return this.reset("daily", date ? { date } : {}); }
  resetAll() { return this.reset("all"); }

  exportData() {
    try {
      return Object.freeze({
        version: 1,
        exportedAt: Date.now(),
        dataCapBytes: this.dataCapBytes,
        allTime: Object.freeze(cloneCounters(this._allTime)),
        daily: Object.freeze(Object.fromEntries(Object.entries(this._daily).map(([key, counters]) => [key, Object.freeze(cloneCounters(counters))]))),
      });
    } catch (error) { this._reportError(error); return Object.freeze({ version: 1, allTime: Object.freeze(createCounters()), daily: Object.freeze({}) }); }
  }

  exportJSON(space = 0) {
    try {
      const indentation = Number.isInteger(Number(space)) ? Math.max(0, Math.min(10, Number(space))) : 0;
      return JSON.stringify(this.exportData(), null, indentation);
    } catch (error) { this._reportError(error); return ""; }
  }

  importData(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      let parsed = input;
      if (typeof input === "string") parsed = JSON.parse(input);
      if (!isRecord(parsed) || !isRecord(parsed.allTime)) return false;
      const settings = isRecord(options) ? options : {};
      const importedAllTime = normalizeCounters(parsed.allTime);
      const importedDaily = Object.create(null);
      if (isRecord(parsed.daily)) {
        for (const [date, counters] of Object.entries(parsed.daily)) {
          const key = normalizeDateKey(date, "");
          if (key) importedDaily[key] = normalizeCounters(counters);
        }
      }
      if (settings.replace === false) {
        for (const [key, value] of Object.entries(importedAllTime.byNetwork)) this._allTime.byNetwork[key] += value;
        this._allTime.totalBytes += importedAllTime.totalBytes;
        for (const field of ["byVideo", "byCategory"]) {
          for (const [key, value] of Object.entries(importedAllTime[field])) this._allTime[field][key] = (this._allTime[field][key] ?? 0) + value;
        }
        for (const [day, counters] of Object.entries(importedDaily)) {
          const target = this._daily[day] ?? (this._daily[day] = createCounters());
          target.totalBytes += counters.totalBytes;
          for (const type of NETWORK_TYPES) target.byNetwork[type] += counters.byNetwork[type];
          for (const field of ["byVideo", "byCategory"]) {
            for (const [key, value] of Object.entries(counters[field])) target[field][key] = (target[field][key] ?? 0) + value;
          }
        }
      } else {
        this._allTime = importedAllTime;
        this._daily = importedDaily;
      }
      if (parsed.dataCapBytes !== undefined) this.dataCapBytes = nonNegative(parsed.dataCapBytes, null);
      this._persist();
      this._notify("import", { importedAt: parsed.exportedAt ?? null });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  importJSON(json, options) { return this.importData(json, options); }

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

  destroy() {
    try {
      if (this.isDestroyed) return true;
      this._listeners.clear();
      this.onChange = null;
      this.onWarning = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a data usage tracker without throwing in restricted environments. */
export function createDataUsageTracker(options = {}) {
  try { return new DataUsageTracker(options); }
  catch { return null; }
}

export { NETWORK_TYPES };

export default Object.freeze({
  NETWORK_TYPES,
  DataUsageTracker,
  createDataUsageTracker,
  formatBytes,
});
