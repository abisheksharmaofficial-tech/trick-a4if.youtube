const STORAGE_KEY = "trick-a4if-tube:comment-notes";
const DEFAULT_MAX_NOTES = 10000;
const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 20000;
let generatedIdCounter = 0;

function isRecord(value) {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); }
  catch { return false; }
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  try { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
  catch { return ""; }
}

function normalizeId(value) {
  try { return normalizeText(value, MAX_ID_LENGTH); }
  catch { return ""; }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  try {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
  } catch { return fallback; }
}

function normalizeSeconds(value) {
  try {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch { return null; }
}

function createNoteId() {
  try {
    const cryptoObject = globalThis.crypto;
    if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();
  } catch { /* Use a local counter where crypto is unavailable. */ }
  generatedIdCounter += 1;
  return `note-${Date.now().toString(36)}-${generatedIdCounter.toString(36)}`;
}

function normalizeTags(value) {
  try {
    if (!Array.isArray(value)) return Object.freeze([]);
    const unique = new Set();
    const tags = [];
    for (const candidate of value) {
      const tag = normalizeText(candidate, 128);
      const key = tag.toLocaleLowerCase();
      if (!tag || unique.has(key)) continue;
      unique.add(key);
      tags.push(tag);
      if (tags.length >= 100) break;
    }
    return Object.freeze(tags);
  } catch { return Object.freeze([]); }
}

function normalizeNote(input, options = {}) {
  try {
    if (!isRecord(input)) return null;
    const videoId = normalizeId(input.videoId ?? input.video ?? options.videoId);
    const text = normalizeText(input.text ?? input.comment ?? input.note);
    if (!videoId || !text) return null;
    const createdAt = normalizeTimestamp(input.createdAt, options.now ?? Date.now());
    return Object.freeze({
      id: normalizeId(input.id) || createNoteId(),
      videoId,
      text,
      timestamp: normalizeSeconds(input.timestamp ?? input.timestampSeconds ?? input.timeSeconds ?? input.time),
      tags: normalizeTags(input.tags),
      pinned: input.pinned === true || input.isPinned === true,
      resolved: input.resolved === true || input.isResolved === true,
      createdAt,
      updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    });
  } catch { return null; }
}

function resolveStorage(candidate) {
  try {
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    return globalThis.localStorage ?? null;
  } catch { return null; }
}

function normalizeLimit(value) {
  try {
    if (value === Infinity) return Infinity;
    const limit = Number(value);
    return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_MAX_NOTES;
  } catch { return DEFAULT_MAX_NOTES; }
}

function normalizeSort(value) {
  try {
    const sort = normalizeText(value, 32).toLowerCase();
    return ["created-asc", "created-desc", "updated-asc", "updated-desc", "timestamp-asc", "timestamp-desc", "text-asc", "text-desc"].includes(sort)
      ? sort : "created-desc";
  } catch { return "created-desc"; }
}

function normalizeCollection(input, maxNotes) {
  try {
    const values = Array.isArray(input) ? input
      : isRecord(input) && Array.isArray(input.notes) ? input.notes : null;
    const notes = new Map();
    if (!values) return notes;
    for (const value of values) {
      const note = normalizeNote(value);
      if (!note) continue;
      if (notes.has(note.id)) notes.delete(note.id);
      notes.set(note.id, note);
    }
    while (notes.size > maxNotes) notes.delete(notes.keys().next().value);
    return notes;
  } catch { return new Map(); }
}

/**
 * Store timestamped notes and comments associated with videos. Persistence is
 * local-only; storage failures leave the current manager usable in memory.
 */
export class CommentNotesManager {
  constructor(options = {}) {
    const settings = isRecord(options) ? options : {};
    this.storage = resolveStorage(settings.storage);
    this.storageKey = normalizeText(settings.storageKey, 512) || STORAGE_KEY;
    this.maxNotes = normalizeLimit(settings.maxNotes ?? settings.limit ?? DEFAULT_MAX_NOTES);
    this.defaultVideoId = normalizeId(settings.videoId);
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this.lastError = null;
    this.isDestroyed = false;
    this._notes = new Map();
    this._listeners = new Set();
    this._load();
    if (Array.isArray(settings.notes) && this._notes.size === 0) {
      this.importNotes(settings.notes, { replace: true, silent: true });
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Comment notes operation failed.");
      try { this.onError?.(this.lastError, this); } catch { /* Isolate callback failures. */ }
    } catch { /* Error handling must not interrupt the caller. */ }
  }

  _load() {
    try {
      let serialized = null;
      try { serialized = this.storage?.getItem(this.storageKey); }
      catch (error) { this._reportError(error); }
      if (typeof serialized !== "string" || !serialized) return false;
      this._notes = normalizeCollection(JSON.parse(serialized), this.maxNotes);
      return true;
    } catch (error) {
      this._reportError(error);
      this._notes = new Map();
      return false;
    }
  }

  _persist() {
    try {
      if (!this.storage || typeof this.storage.setItem !== "function") return false;
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, notes: this.getNotes() }));
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  _notify(type, note = null, details = {}) {
    try {
      const event = Object.freeze({ type, note, notes: this.getNotes(), count: this._notes.size, ...details });
      try { this.onChange?.(event, this); } catch (error) { this._reportError(error); }
      for (const listener of [...this._listeners]) {
        try { listener(event, this); } catch (error) { this._reportError(error); }
      }
      return event;
    } catch (error) { this._reportError(error); return null; }
  }

  _commit(type, note, details = {}) {
    try { this._persist(); this._notify(type, note, details); return true; }
    catch (error) { this._reportError(error); return false; }
  }

  /** Add a note. Returns the new immutable note, or null if invalid/capacity is reached. */
  addNote(input, options = {}) {
    try {
      if (this.isDestroyed || this.maxNotes === 0) return null;
      const settings = isRecord(options) ? options : {};
      const source = isRecord(input) ? { ...input } : { text: input };
      if (!source.videoId && settings.videoId) source.videoId = settings.videoId;
      if (!source.videoId && this.defaultVideoId) source.videoId = this.defaultVideoId;
      const note = normalizeNote(source, { videoId: settings.videoId ?? this.defaultVideoId, now: Date.now() });
      if (!note) return null;
      const existing = this._notes.get(note.id);
      if (!existing && this._notes.size >= this.maxNotes) {
        if (settings.evictOldest !== true) return null;
        this._notes.delete(this._notes.keys().next().value);
      }
      if (existing && settings.updateExisting !== true) return existing;
      this._notes.set(note.id, note);
      this._commit(existing ? "update" : "add", note);
      return note;
    } catch (error) { this._reportError(error); return null; }
  }

  add(input, options) { return this.addNote(input, options); }

  updateNote(id, patch = {}) {
    try {
      if (this.isDestroyed || !isRecord(patch)) return null;
      const noteId = normalizeId(id);
      const existing = this._notes.get(noteId);
      if (!existing) return null;
      const merged = { ...existing, ...patch, id: existing.id, videoId: patch.videoId ?? existing.videoId,
        createdAt: existing.createdAt, updatedAt: Date.now() };
      const updated = normalizeNote(merged);
      if (!updated) return null;
      this._notes.set(noteId, updated);
      this._commit("update", updated, { previousNote: existing });
      return updated;
    } catch (error) { this._reportError(error); return null; }
  }

  update(id, patch) { return this.updateNote(id, patch); }

  deleteNote(id) {
    try {
      if (this.isDestroyed) return false;
      const noteId = normalizeId(id);
      const note = this._notes.get(noteId);
      if (!note) return false;
      this._notes.delete(noteId);
      this._commit("delete", note);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeNote(id) { return this.deleteNote(id); }
  remove(id) { return this.deleteNote(id); }

  _setFlag(id, flag, value) {
    try {
      if (this.isDestroyed) return false;
      const noteId = normalizeId(id);
      const existing = this._notes.get(noteId);
      if (!existing) return false;
      const updated = Object.freeze({ ...existing, [flag]: Boolean(value), updatedAt: Date.now() });
      this._notes.set(noteId, updated);
      this._commit(flag, updated, { previousNote: existing });
      return updated;
    } catch (error) { this._reportError(error); return false; }
  }

  setPinned(id, pinned = true) { return this._setFlag(id, "pinned", pinned); }
  togglePinned(id) {
    try { const note = this._notes.get(normalizeId(id)); return note ? this.setPinned(note.id, !note.pinned) : false; }
    catch (error) { this._reportError(error); return false; }
  }
  pin(id) { return this.setPinned(id, true); }
  unpin(id) { return this.setPinned(id, false); }

  setResolved(id, resolved = true) { return this._setFlag(id, "resolved", resolved); }
  toggleResolved(id) {
    try { const note = this._notes.get(normalizeId(id)); return note ? this.setResolved(note.id, !note.resolved) : false; }
    catch (error) { this._reportError(error); return false; }
  }
  resolve(id) { return this.setResolved(id, true); }
  reopen(id) { return this.setResolved(id, false); }

  getNote(id) {
    try { return this._notes.get(normalizeId(id)) ?? null; }
    catch (error) { this._reportError(error); return null; }
  }

  /** Query all notes or filter by video, text, tags, pin/resolution, and sorting. */
  getNotes(options = {}) {
    try {
      const settings = isRecord(options) ? options : {};
      let notes = Array.from(this._notes.values());
      const videoId = normalizeId(settings.videoId ?? settings.video);
      if (videoId) notes = notes.filter((note) => note.videoId === videoId);
      if (typeof settings.pinned === "boolean") notes = notes.filter((note) => note.pinned === settings.pinned);
      if (typeof settings.resolved === "boolean") notes = notes.filter((note) => note.resolved === settings.resolved);
      if (settings.unresolved === true) notes = notes.filter((note) => !note.resolved);
      if (settings.hasTimestamp === true) notes = notes.filter((note) => note.timestamp !== null);
      const tag = normalizeText(settings.tag, 128).toLocaleLowerCase();
      const tags = Array.isArray(settings.tags) ? settings.tags.map((value) => normalizeText(value, 128).toLocaleLowerCase()).filter(Boolean) : [];
      if (tag) notes = notes.filter((note) => note.tags.some((item) => item.toLocaleLowerCase() === tag));
      if (tags.length) {
        const requireAll = settings.matchAllTags === true;
        notes = notes.filter((note) => {
          const noteTags = note.tags.map((item) => item.toLocaleLowerCase());
          return requireAll ? tags.every((item) => noteTags.includes(item)) : tags.some((item) => noteTags.includes(item));
        });
      }
      const query = normalizeText(settings.query ?? settings.search, 2048).toLocaleLowerCase();
      if (query) notes = notes.filter((note) => [note.videoId, note.text, ...note.tags]
        .some((value) => value.toLocaleLowerCase().includes(query)));
      const sort = normalizeSort(settings.sort);
      notes.sort((left, right) => {
        switch (sort) {
          case "created-asc": return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
          case "updated-asc": return left.updatedAt - right.updatedAt || left.id.localeCompare(right.id);
          case "updated-desc": return right.updatedAt - left.updatedAt || right.id.localeCompare(left.id);
          case "timestamp-asc": return (left.timestamp ?? Infinity) - (right.timestamp ?? Infinity) || left.createdAt - right.createdAt;
          case "timestamp-desc": return (right.timestamp ?? -Infinity) - (left.timestamp ?? -Infinity) || right.createdAt - left.createdAt;
          case "text-asc": return left.text.localeCompare(right.text) || left.createdAt - right.createdAt;
          case "text-desc": return right.text.localeCompare(left.text) || right.createdAt - left.createdAt;
          default: return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
        }
      });
      if (settings.limit != null) {
        const limit = Number(settings.limit);
        if (Number.isFinite(limit) && limit >= 0) notes = notes.slice(0, Math.floor(limit));
      }
      return Object.freeze(notes);
    } catch (error) { this._reportError(error); return Object.freeze([]); }
  }

  query(options = {}) { return this.getNotes(options); }
  search(query, options = {}) { return this.getNotes({ ...options, query }); }
  get count() { return this._notes.size; }

  exportData() {
    try { return Object.freeze({ version: 1, notes: this.getNotes() }); }
    catch (error) { this._reportError(error); return Object.freeze({ version: 1, notes: Object.freeze([]) }); }
  }

  exportJSON(space = 0) {
    try {
      const indentation = Number.isInteger(Number(space)) ? Math.max(0, Math.min(10, Number(space))) : 0;
      return JSON.stringify(this.exportData(), null, indentation);
    } catch (error) { this._reportError(error); return ""; }
  }

  /** Import JSON text, a note array, or {notes}; replace by default. */
  importNotes(input, options = {}) {
    try {
      if (this.isDestroyed) return false;
      const settings = isRecord(options) ? options : {};
      let parsed = input;
      if (typeof input === "string") parsed = JSON.parse(input);
      const incoming = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.notes) ? parsed.notes : null);
      if (!incoming) return false;
      const next = settings.replace === false ? new Map(this._notes) : new Map();
      for (const candidate of incoming) {
        const note = normalizeNote(candidate);
        if (!note) continue;
        if (next.has(note.id)) next.delete(note.id);
        next.set(note.id, note);
      }
      while (next.size > this.maxNotes) next.delete(next.keys().next().value);
      const previousCount = this._notes.size;
      this._notes = next;
      if (settings.silent !== true) {
        this._persist();
        this._notify("import", null, { importedCount: incoming.length, previousCount });
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  importJSON(json, options) { return this.importNotes(json, options); }

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

  setMaxNotes(value, options = {}) {
    try {
      if (this.isDestroyed) return false;
      this.maxNotes = normalizeLimit(value);
      let removedCount = 0;
      while (this._notes.size > this.maxNotes) {
        this._notes.delete(this._notes.keys().next().value);
        removedCount += 1;
      }
      if (removedCount && !(isRecord(options) && options.silent === true)) {
        this._persist();
        this._notify("capacity", null, { maxNotes: this.maxNotes, removedCount });
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  clear(options = {}) {
    try {
      if (this.isDestroyed) return false;
      if (!this._notes.size) return true;
      const previousCount = this._notes.size;
      this._notes.clear();
      this._commit("clear", null, { previousCount });
      if (isRecord(options) && options.removeStorage === true) {
        try { this.storage?.removeItem?.(this.storageKey); } catch (error) { this._reportError(error); }
      }
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  destroy(options = {}) {
    try {
      if (this.isDestroyed) return true;
      if (isRecord(options) && options.clear === true) this._notes.clear();
      this._listeners.clear();
      this.onChange = null;
      this.onError = null;
      this.storage = null;
      this.isDestroyed = true;
      return true;
    } catch (error) { this._reportError(error); this.isDestroyed = true; return false; }
  }
}

/** Create a notes manager safely where browser storage may be unavailable. */
export function createCommentNotesManager(options = {}) {
  try { return new CommentNotesManager(options); }
  catch { return null; }
}

export default Object.freeze({
  CommentNotesManager,
  createCommentNotesManager,
});
