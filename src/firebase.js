import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { getDatabase, onValue, ref, get, set, remove } from "firebase/database";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getDeviceScopedStorageKey, safeStorageGet, safeStorageSet } from "./deviceStorage.js";

const PROJECT_ID = "tricka4ifytapp";
const STORAGE_KEYS = Object.freeze({
  savedVideos: "saved-videos:v1",
  subscriptions: "subscriptions:v1",
  watchHistory: "watch-history:v1",
});
const MAX_HISTORY_ITEMS = 500;
const localListeners = new Map();
const cloudUnsubscribers = new Map();

function readEnvironment() {
  try {
    return import.meta.env ?? {};
  } catch {
    return {};
  }
}

const environment = readEnvironment();
const firebaseConfig = {
  apiKey: environment.VITE_FIREBASE_API_KEY || "",
  authDomain: environment.VITE_FIREBASE_AUTH_DOMAIN || `${PROJECT_ID}.firebaseapp.com`,
  databaseURL: environment.VITE_FIREBASE_DATABASE_URL || `https://${PROJECT_ID}-default-rtdb.firebaseio.com`,
  projectId: PROJECT_ID,
  storageBucket: environment.VITE_FIREBASE_STORAGE_BUCKET || `${PROJECT_ID}.appspot.com`,
  messagingSenderId: environment.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: environment.VITE_FIREBASE_APP_ID || "",
  measurementId: environment.VITE_FIREBASE_MEASUREMENT_ID || "",
};

/** Firebase app instance. Supply project credentials via Vite environment variables. */
export const app = (() => {
  try {
    return getApps().length ? getApp() : initializeApp(firebaseConfig);
  } catch {
    return null;
  }
})();

export const auth = (() => {
  try {
    return app ? getAuth(app) : null;
  } catch {
    return null;
  }
})();

// Firestore is intentionally not configured; this application uses Realtime Database.
export const db = null;

export const rtdb = (() => {
  try {
    return app ? getDatabase(app) : null;
  } catch {
    return null;
  }
})();

export let analytics = null;

try {
  if (app && typeof window !== "undefined") {
    isSupported().then((supported) => {
      if (!supported) return;
      try {
        analytics = getAnalytics(app);
      } catch {
        analytics = null;
      }
    }).catch(() => {
      analytics = null;
    });
  }
} catch {
  analytics = null;
}

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function normalizeText(value, maxLength = 1000) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value).trim().slice(0, maxLength);
  } catch {
    return "";
  }
}

function normalizeId(value) {
  const id = normalizeText(value, 512);
  return id && !/[.#$\[\]/\u0000-\u001f]/.test(id) ? id : "";
}

function currentUserId() {
  try {
    return normalizeId(auth?.currentUser?.uid);
  } catch {
    return "";
  }
}

function scopedKey(kind) {
  try {
    return getDeviceScopedStorageKey(STORAGE_KEYS[kind]);
  } catch {
    return "";
  }
}

function readLocal(kind, fallback) {
  try {
    const key = scopedKey(kind);
    if (!key) return fallback;
    const value = safeStorageGet(key);
    if (typeof value !== "string") return fallback;
    const parsed = JSON.parse(value);
    return kind === "watchHistory" && Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(kind, value) {
  try {
    const key = scopedKey(kind);
    if (!key) return false;
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return false;
    safeStorageSet(key, serialized);
    notifyLocal(kind, value);
    return true;
  } catch {
    return false;
  }
}

function notifyLocal(kind, value) {
  try {
    const listeners = localListeners.get(kind);
    if (!listeners) return;
    const snapshot = Array.isArray(value) ? value.slice() : { ...value };
    listeners.forEach((listener) => {
      try { listener(snapshot); } catch { /* Subscriber exceptions must not interrupt other listeners. */ }
    });
  } catch {
    // Notifications are best-effort and must not break storage operations.
  }
}

function subscribeLocal(kind, callback) {
  if (typeof callback !== "function") return () => {};
  try {
    if (!localListeners.has(kind)) localListeners.set(kind, new Set());
    const listeners = localListeners.get(kind);
    listeners.add(callback);
    callback(readLocal(kind, kind === "watchHistory" ? [] : {}));
    return () => {
      try { listeners.delete(callback); } catch { /* No-op. */ }
    };
  } catch {
    return () => {};
  }
}

function cloudPath(collection, uid = currentUserId()) {
  const userId = normalizeId(uid);
  return userId && collection ? `users/${userId}/${collection}` : "";
}

function attachCloudSubscription(kind, collection, callback) {
  try {
    const uid = currentUserId();
    const path = cloudPath(collection, uid);
    if (!rtdb || !path || typeof callback !== "function") return () => {};
    const subscriptionId = `${kind}:${uid}`;
    const oldUnsubscribe = cloudUnsubscribers.get(subscriptionId);
    if (oldUnsubscribe) oldUnsubscribe();
    const unsubscribe = onValue(ref(rtdb, path), (snapshot) => {
      try {
        const value = snapshot.exists() ? snapshot.val() : kind === "watchHistory" ? [] : {};
        const normalized = kind === "watchHistory" && Array.isArray(value)
          ? value : isRecord(value) ? value : {};
        writeLocal(kind, normalized);
        callback(Array.isArray(normalized) ? normalized.slice() : { ...normalized });
      } catch {
        // Ignore invalid or unavailable remote snapshots.
      }
    }, () => {
      // A local subscription remains active if the remote listener fails.
    });
    cloudUnsubscribers.set(subscriptionId, unsubscribe);
    return () => {
      try { unsubscribe(); } catch { /* No-op. */ }
      if (cloudUnsubscribers.get(subscriptionId) === unsubscribe) cloudUnsubscribers.delete(subscriptionId);
    };
  } catch {
    return () => {};
  }
}

async function ensureAnonymousUser() {
  try {
    if (!auth) return null;
    if (auth.currentUser) return auth.currentUser;
    if (!firebaseConfig.apiKey) return null;
    const result = await signInAnonymously(auth);
    return result?.user ?? null;
  } catch {
    return null;
  }
}

function syncLocalCollection(kind, collection, value) {
  try {
    writeLocal(kind, value);
    const uid = currentUserId();
    const path = cloudPath(collection, uid);
    if (rtdb && path) {
      set(ref(rtdb, path), value).catch(() => {
        // Local state is retained if cloud synchronization is offline or denied.
      });
    }
    return value;
  } catch {
    return value;
  }
}

/** Record an Analytics event when Analytics is supported and initialized. */
export function trackAppEvent(eventName, parameters = {}) {
  try {
    const name = normalizeText(eventName, 40).replace(/[^a-zA-Z0-9_]/g, "_");
    if (!name || !analytics) return false;
    // Imported lazily to keep Analytics optional in unsupported environments.
    import("firebase/analytics").then(({ logEvent }) => {
      try { if (analytics) logEvent(analytics, name, isRecord(parameters) ? parameters : {}); } catch { /* Optional telemetry. */ }
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Initialize anonymous Firebase auth and reconnect active local subscriptions. */
export async function initAnonymousCloudSync() {
  try {
    const user = await ensureAnonymousUser();
    if (!user) return null;
    for (const kind of Object.keys(STORAGE_KEYS)) {
      const collection = kind === "savedVideos" ? "savedVideos"
        : kind === "subscriptions" ? "subscriptions" : "watchHistory";
      const listeners = localListeners.get(kind);
      if (!listeners?.size || !rtdb) continue;
      const path = cloudPath(collection, user.uid);
      const subscriptionId = `${kind}:${user.uid}`;
      if (cloudUnsubscribers.has(subscriptionId)) continue;
      const unsubscribe = onValue(ref(rtdb, path), (snapshot) => {
        try {
          const remote = snapshot.exists() ? snapshot.val() : kind === "watchHistory" ? [] : {};
          const value = kind === "watchHistory" && Array.isArray(remote) ? remote : isRecord(remote) ? remote : {};
          writeLocal(kind, value);
        } catch { /* Keep local state if a remote snapshot is malformed. */ }
      }, () => {});
      cloudUnsubscribers.set(subscriptionId, unsubscribe);
    }
    return user;
  } catch {
    return null;
  }
}

/** Subscribe to saved video records, receiving local updates immediately. */
export function subscribeSavedVideos(callback, options = {}) {
  try {
    const unsubscribeLocal = subscribeLocal("savedVideos", callback);
    const collection = normalizeText(options.collection, 128) || "savedVideos";
    const unsubscribeCloud = attachCloudSubscription("savedVideos", collection, callback);
    return () => { unsubscribeLocal(); unsubscribeCloud(); };
  } catch {
    return () => {};
  }
}

/** Toggle a video in the locally persisted and optionally cloud-synced saved list. */
export async function toggleSaveVideoToCloud(video, options = {}) {
  try {
    const record = isRecord(video) ? { ...video } : { id: video };
    const id = normalizeId(record.id ?? record.videoId ?? record.key);
    if (!id) return false;
    record.id = id;
    const saved = readLocal("savedVideos", {});
    const next = { ...saved };
    const shouldSave = options.saved === undefined ? !Object.prototype.hasOwnProperty.call(saved, id) : options.saved === true;
    if (shouldSave) next[id] = { ...record, savedAt: Date.now() };
    else delete next[id];
    syncLocalCollection("savedVideos", normalizeText(options.collection, 128) || "savedVideos", next);
    if (!currentUserId()) await ensureAnonymousUser();
    const uid = currentUserId();
    const path = cloudPath(`${normalizeText(options.collection, 128) || "savedVideos"}/${id}`, uid);
    if (rtdb && path) {
      try {
        if (shouldSave) await set(ref(rtdb, path), next[id]);
        else await remove(ref(rtdb, path));
      } catch { /* Local update remains available offline. */ }
    }
    return shouldSave;
  } catch {
    return false;
  }
}

/** Subscribe to channel subscription records. */
export function subscribeSubscriptions(callback, options = {}) {
  try {
    const unsubscribeLocal = subscribeLocal("subscriptions", callback);
    const collection = normalizeText(options.collection, 128) || "subscriptions";
    const unsubscribeCloud = attachCloudSubscription("subscriptions", collection, callback);
    return () => { unsubscribeLocal(); unsubscribeCloud(); };
  } catch {
    return () => {};
  }
}

/** Toggle a channel subscription locally and, when available, in Realtime Database. */
export async function toggleChannelSubscription(channel, options = {}) {
  try {
    const record = isRecord(channel) ? { ...channel } : { id: channel };
    const id = normalizeId(record.id ?? record.channelId ?? record.key);
    if (!id) return false;
    record.id = id;
    const subscriptions = readLocal("subscriptions", {});
    const next = { ...subscriptions };
    const shouldSubscribe = options.subscribed === undefined
      ? !Object.prototype.hasOwnProperty.call(subscriptions, id) : options.subscribed === true;
    if (shouldSubscribe) next[id] = { ...record, subscribedAt: Date.now() };
    else delete next[id];
    const collection = normalizeText(options.collection, 128) || "subscriptions";
    writeLocal("subscriptions", next);
    if (!currentUserId()) await ensureAnonymousUser();
    const path = cloudPath(`${collection}/${id}`);
    if (rtdb && path) {
      try {
        if (shouldSubscribe) await set(ref(rtdb, path), next[id]);
        else await remove(ref(rtdb, path));
      } catch { /* Preserve local state when remote sync fails. */ }
    }
    return shouldSubscribe;
  } catch {
    return false;
  }
}

/** Subscribe to the caller's watch-history records. */
export function subscribeWatchHistory(callback, options = {}) {
  try {
    const unsubscribeLocal = subscribeLocal("watchHistory", callback);
    const collection = normalizeText(options.collection, 128) || "watchHistory";
    const unsubscribeCloud = attachCloudSubscription("watchHistory", collection, callback);
    return () => { unsubscribeLocal(); unsubscribeCloud(); };
  } catch {
    return () => {};
  }
}

/** Add or update a watch-history record, bounding local history size. */
export async function recordWatchHistory(video, options = {}) {
  try {
    const record = isRecord(video) ? { ...video } : { id: video };
    const id = normalizeId(record.id ?? record.videoId ?? record.key);
    if (!id) return false;
    const history = readLocal("watchHistory", []);
    const item = { ...record, id, watchedAt: Number.isFinite(Number(record.watchedAt)) ? Number(record.watchedAt) : Date.now() };
    const next = [item, ...history.filter((entry) => normalizeId(entry?.id ?? entry?.videoId) !== id)]
      .slice(0, MAX_HISTORY_ITEMS);
    const collection = normalizeText(options.collection, 128) || "watchHistory";
    writeLocal("watchHistory", next);
    if (!currentUserId()) await ensureAnonymousUser();
    const path = cloudPath(collection);
    if (rtdb && path) {
      try { await set(ref(rtdb, path), next); } catch { /* Local history remains usable offline. */ }
    }
    return true;
  } catch {
    return false;
  }
}

export default app;
