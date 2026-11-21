const STORAGE_NAMESPACE = "trick_a4if_tube";
const DEVICE_ID_STORAGE_KEY = `${STORAGE_NAMESPACE}:client-id:v1`;
const MAX_BASE_KEY_LENGTH = 512;
const MAX_DEVICE_ID_LENGTH = 256;
const memoryStorage = new Map();

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, maxLength) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maxLength);
  } catch {
    return "";
  }
}

function normalizeBaseKey(value) {
  const key = normalizeText(value, MAX_BASE_KEY_LENGTH);
  if (!key || key === "." || key === "..") return "";

  try {
    // Encode separators and punctuation so a caller-supplied key cannot escape
    // its device-scoped portion of the storage namespace.
    return encodeURIComponent(key).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return "";
  }
}

function resolveStorage(options) {
  try {
    const candidate = isRecord(options) ? options.storage : options;
    if (candidate && typeof candidate.getItem === "function"
      && typeof candidate.setItem === "function"
      && typeof candidate.removeItem === "function") return candidate;
  } catch {
    // A storage getter can throw in restricted browser contexts.
  }

  try {
    const candidate = globalThis.localStorage;
    if (candidate && typeof candidate.getItem === "function"
      && typeof candidate.setItem === "function"
      && typeof candidate.removeItem === "function") return candidate;
  } catch {
    // localStorage may be unavailable, such as during SSR or in private modes.
  }
  return null;
}

function readOptions(options) {
  return isRecord(options) ? options : {};
}

/**
 * Read a value from localStorage, falling back to module-local memory when the
 * API is missing or throws. Returns null when the key has no stored value.
 */
export function safeStorageGet(key, options = {}) {
  try {
    const normalizedKey = normalizeText(key, 2048);
    if (!normalizedKey) return null;

    const storage = resolveStorage(options);
    if (storage) {
      try {
        const value = storage.getItem(normalizedKey);
        if (value !== null && value !== undefined) return value;
      } catch {
        // Continue to the memory copy after a storage failure.
      }
    }

    return memoryStorage.has(normalizedKey) ? memoryStorage.get(normalizedKey) : null;
  } catch {
    return null;
  }
}

/**
 * Write a string value to localStorage and keep an in-memory copy as a fallback.
 * Returns true when the value is retained by either storage backend.
 */
export function safeStorageSet(key, value, options = {}) {
  try {
    const normalizedKey = normalizeText(key, 2048);
    if (!normalizedKey || value === null || value === undefined) return false;

    let normalizedValue;
    try {
      normalizedValue = typeof value === "string" ? value : String(value);
    } catch {
      return false;
    }

    memoryStorage.set(normalizedKey, normalizedValue);
    const storage = resolveStorage(options);
    if (storage) {
      try {
        storage.setItem(normalizedKey, normalizedValue);
      } catch {
        // The memory copy preserves functionality when persistence is blocked.
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove a key from both available storage backends. */
export function safeStorageRemove(key, options = {}) {
  try {
    const normalizedKey = normalizeText(key, 2048);
    if (!normalizedKey) return false;

    memoryStorage.delete(normalizedKey);
    const storage = resolveStorage(options);
    if (storage) {
      try {
        storage.removeItem(normalizedKey);
      } catch {
        // Removal from memory still succeeds if browser storage is unavailable.
      }
    }
    return true;
  } catch {
    return false;
  }
}

function createDeviceId() {
  try {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
      const id = cryptoObject.randomUUID.call(cryptoObject);
      if (typeof id === "string" && id.trim()) return id;
    }
  } catch {
    // Use a non-security-sensitive random identifier when Web Crypto is absent.
  }

  try {
    const randomPart = Math.random().toString(36).slice(2);
    return `client-${Date.now().toString(36)}-${randomPart}`;
  } catch {
    return `client-${Date.now().toString(36)}`;
  }
}

function resolveDeviceId(options) {
  const settings = readOptions(options);
  const suppliedId = normalizeText(settings.deviceId ?? settings.clientId, MAX_DEVICE_ID_LENGTH);
  if (suppliedId) return suppliedId;

  const existingId = normalizeText(safeStorageGet(DEVICE_ID_STORAGE_KEY, settings), MAX_DEVICE_ID_LENGTH);
  if (existingId) return existingId;

  const deviceId = createDeviceId();
  safeStorageSet(DEVICE_ID_STORAGE_KEY, deviceId, settings);
  return deviceId;
}

/**
 * Return a stable storage key scoped to this browser installation. A generated
 * client ID is persisted when possible and retained in memory otherwise.
 * Passing `deviceId` (or `clientId`) explicitly allows callers to scope a key
 * to an already-known installation identifier.
 */
export function getDeviceScopedStorageKey(baseKey, options = {}) {
  try {
    const normalizedKey = normalizeBaseKey(baseKey);
    if (!normalizedKey) return "";

    const deviceId = normalizeText(resolveDeviceId(options), MAX_DEVICE_ID_LENGTH);
    if (!deviceId) return "";

    let encodedDeviceId;
    try {
      encodedDeviceId = encodeURIComponent(deviceId);
    } catch {
      return "";
    }

    return `${STORAGE_NAMESPACE}:${encodedDeviceId}:${normalizedKey}`;
  } catch {
    return "";
  }
}

export default getDeviceScopedStorageKey;
