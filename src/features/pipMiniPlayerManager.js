const DOCK_CORNERS = Object.freeze(["bottom-right", "bottom-left", "top-right", "top-left"]);
const DEFAULT_CORNER = "bottom-right";
const MANAGER_EVENTS = Object.freeze(["open", "close", "modechange", "error"]);

function isElement(value) {
  try {
    return Boolean(value && typeof value === "object" && value.nodeType === 1);
  } catch {
    return false;
  }
}

function normalizeCorner(value, fallback = DEFAULT_CORNER) {
  try {
    return DOCK_CORNERS.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function invokeSafely(callback, detail, manager) {
  try {
    if (typeof callback === "function") callback(detail, manager);
  } catch (error) {
    manager._reportError(error);
  }
}

/**
 * Manage native video Picture-in-Picture where available, with an in-page
 * floating mini-player fallback. The supplied video remains caller-owned.
 */
export class PipMiniPlayerManager {
  constructor(options = {}) {
    const settings = options && typeof options === "object" ? options : {};
    this.video = settings.videoElement ?? settings.video ?? null;
    this.document = settings.document ?? this.video?.ownerDocument ?? globalThis.document ?? null;
    this.window = settings.window ?? this.document?.defaultView ?? globalThis.window ?? null;
    this.container = isElement(settings.container) ? settings.container : (this.document?.body ?? null);
    this.modePreference = settings.mode === "fallback" ? "fallback" : "native";
    this.autoMiniPlayer = settings.autoMiniPlayer === true || settings.autoMiniPlayerOnScroll === true;
    this.visibilityThreshold = this._normalizeThreshold(settings.visibilityThreshold);
    this.dockCorner = normalizeCorner(settings.dockCorner ?? settings.position);
    this.isOpen = false;
    this.isDestroyed = false;
    this.mode = "closed";
    this.lastError = null;
    this.onOpen = typeof settings.onOpen === "function" ? settings.onOpen : null;
    this.onClose = typeof settings.onClose === "function" ? settings.onClose : null;
    this.onModeChange = typeof settings.onModeChange === "function" ? settings.onModeChange : null;
    this.onError = typeof settings.onError === "function" ? settings.onError : null;
    this._listeners = new Map(MANAGER_EVENTS.map((eventName) => [eventName, new Set()]));
    this._fallbackRoot = null;
    this._placeholder = null;
    this._originalParent = null;
    this._originalNextSibling = null;
    this._originalVideoStyle = null;
    this._observer = null;
    this._boundEnterPiP = () => this._handleNativeOpen();
    this._boundLeavePiP = () => this._handleNativeClose();
    this._boundScroll = () => this._checkVisibility();
    this._boundResize = () => this._checkVisibility();
    this._boundFullscreenChange = () => this._handleFullscreenChange();
    this._boundFallbackClose = () => { void this.close(); };

    this._attachMediaListeners();
    if (this.autoMiniPlayer) this._attachVisibilityMonitoring();
  }

  _normalizeThreshold(value) {
    try {
      const threshold = Number(value);
      return Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.25;
    } catch {
      return 0.25;
    }
  }

  _reportError(error) {
    try {
      this.lastError = error instanceof Error ? error : new Error("Picture-in-Picture operation failed.");
      this._emit("error", { error: this.lastError });
      invokeSafely(this.onError, this.lastError, this);
    } catch {
      // Error reporting must never interrupt cleanup or event handling.
    }
  }

  _attachMediaListeners() {
    try {
      if (!this.video || typeof this.video.addEventListener !== "function") return false;
      this.video.addEventListener("enterpictureinpicture", this._boundEnterPiP);
      this.video.addEventListener("leavepictureinpicture", this._boundLeavePiP);
      this.document?.addEventListener?.("fullscreenchange", this._boundFullscreenChange);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _attachVisibilityMonitoring() {
    try {
      if (!this.video) return false;
      const Observer = this.window?.IntersectionObserver ?? globalThis.IntersectionObserver;
      if (typeof Observer === "function") {
        this._observer = new Observer((entries) => {
          try {
            const entry = entries?.find((item) => item.target === this.video) ?? entries?.[0];
            if (!entry || this.isDestroyed) return;
            const visible = entry.isIntersecting && entry.intersectionRatio >= this.visibilityThreshold;
            if (!visible) void this.open({ reason: "out-of-view" });
            else if (this.isOpen && this.mode === "fallback") void this.close({ reason: "in-view" });
          } catch (error) { this._reportError(error); }
        }, { threshold: [this.visibilityThreshold, Math.min(1, this.visibilityThreshold + 0.01)] });
        this._observer.observe(this.video);
        return true;
      }
      const target = this.window;
      target?.addEventListener?.("scroll", this._boundScroll, { passive: true });
      target?.addEventListener?.("resize", this._boundResize, { passive: true });
      this._checkVisibility();
      return Boolean(target);
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _checkVisibility() {
    try {
      if (this.isDestroyed || !this.video?.getBoundingClientRect) return false;
      const rect = this.video.getBoundingClientRect();
      const viewportWidth = Number(this.window?.innerWidth ?? this.document?.documentElement?.clientWidth);
      const viewportHeight = Number(this.window?.innerHeight ?? this.document?.documentElement?.clientHeight);
      if (!(viewportWidth > 0) || !(viewportHeight > 0)) return false;
      const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      const total = Math.max(0, Number(rect.width) * Number(rect.height));
      const ratio = total ? (width * height) / total : 0;
      if (ratio < this.visibilityThreshold) void this.open({ reason: "out-of-view" });
      else if (this.isOpen && this.mode === "fallback") void this.close({ reason: "in-view" });
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _supportsNativePiP() {
    try {
      return Boolean(this.document && this.video
        && typeof this.video.requestPictureInPicture === "function"
        && typeof this.document.exitPictureInPicture === "function"
        && this.document.pictureInPictureEnabled !== false);
    } catch {
      return false;
    }
  }

  async open(options = {}) {
    try {
      if (this.isDestroyed || !this.video) return false;
      if (this.isOpen) return true;
      const settings = options && typeof options === "object" ? options : {};
      if (settings.corner || settings.position) this.setDockCorner(settings.corner ?? settings.position);
      const preferNative = settings.mode === "fallback" ? false
        : settings.mode === "native" ? true : this.modePreference !== "fallback";

      if (preferNative && this._supportsNativePiP()) {
        try {
          await this.video.requestPictureInPicture();
          this._handleNativeOpen(settings.reason ?? "api");
          return this.isOpen;
        } catch (error) {
          this._reportError(error);
          if (settings.fallbackOnError === false) return false;
        }
      }
      return this._openFallback(settings.reason ?? "api");
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _openFallback(reason = "api") {
    try {
      if (this.isDestroyed || !this.video || !this.document || !this.container
        || typeof this.document.createElement !== "function"
        || typeof this.container.appendChild !== "function") return false;
      if (this.isOpen) return true;
      const parent = this.video.parentNode;
      if (!parent || typeof parent.insertBefore !== "function") return false;

      this._originalParent = parent;
      this._originalNextSibling = this.video.nextSibling;
      this._originalVideoStyle = this.video.style?.cssText ?? null;

      const placeholder = typeof this.document.createComment === "function"
        ? this.document.createComment("pip-mini-player-video-position")
        : null;
      if (placeholder) {
        parent.insertBefore(placeholder, this.video);
        this._placeholder = placeholder;
      }

      const root = this.document.createElement("div");
      root.className = "pip-mini-player";
      root.setAttribute("data-pip-mini-player", "true");
      root.setAttribute("role", "group");
      root.setAttribute("aria-label", "Mini player");
      Object.assign(root.style, {
        position: "fixed", zIndex: "2147483647", width: "min(360px, calc(100vw - 24px))",
        maxHeight: "calc(100vh - 24px)", background: "#000", borderRadius: "8px",
        overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,.35)",
      });

      const controls = this.document.createElement("div");
      controls.className = "pip-mini-player__controls";
      Object.assign(controls.style, {
        position: "absolute", top: "8px", right: "8px", zIndex: "1",
        display: "flex", gap: "6px",
      });
      const restoreButton = this._createButton("Restore player", "↗", () => { void this.restore(); });
      const closeButton = this._createButton("Close mini player", "×", this._boundFallbackClose);
      controls.append(restoreButton, closeButton);
      root.appendChild(controls);

      this._fallbackRoot = root;
      this._applyDockStyles();
      this.container.appendChild(root);
      root.appendChild(this.video);
      if (this.video.style) {
        Object.assign(this.video.style, {
          display: "block", width: "100%", height: "auto", maxHeight: "calc(100vh - 24px)",
        });
      }
      this.isOpen = true;
      this._setMode("fallback", { reason });
      this._emit("open", { mode: this.mode, reason });
      invokeSafely(this.onOpen, { mode: this.mode, reason }, this);
      return true;
    } catch (error) {
      this._restoreVideoPosition();
      this._removeFallbackRoot();
      this._reportError(error);
      return false;
    }
  }

  _createButton(label, text, callback) {
    try {
      const button = this.document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.setAttribute("aria-label", label);
      button.title = label;
      Object.assign(button.style, {
        width: "32px", height: "32px", border: "0", borderRadius: "4px",
        color: "#fff", background: "rgba(0,0,0,.72)", cursor: "pointer", font: "inherit",
      });
      button.addEventListener("click", callback);
      return button;
    } catch (error) {
      this._reportError(error);
      throw error;
    }
  }

  _applyDockStyles() {
    try {
      const root = this._fallbackRoot;
      if (!root) return false;
      root.style.top = this.dockCorner.startsWith("top-") ? "12px" : "auto";
      root.style.bottom = this.dockCorner.startsWith("bottom-") ? "12px" : "auto";
      root.style.left = this.dockCorner.endsWith("left") ? "12px" : "auto";
      root.style.right = this.dockCorner.endsWith("right") ? "12px" : "auto";
      root.setAttribute("data-dock-corner", this.dockCorner);
      return true;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _setMode(mode, detail = {}) {
    try {
      if (this.mode === mode) return;
      const previousMode = this.mode;
      this.mode = mode;
      this._emit("modechange", { mode, previousMode, ...detail });
      invokeSafely(this.onModeChange, { mode, previousMode, ...detail }, this);
    } catch (error) { this._reportError(error); }
  }

  _handleNativeOpen(reason = "native") {
    try {
      if (this.isDestroyed) return;
      const wasOpen = this.isOpen;
      this.isOpen = true;
      this._setMode("native", { reason });
      if (!wasOpen) {
        this._emit("open", { mode: "native", reason });
        invokeSafely(this.onOpen, { mode: "native", reason }, this);
      }
    } catch (error) { this._reportError(error); }
  }

  _handleNativeClose(reason = "native") {
    try {
      if (this.isDestroyed && !this.isOpen) return;
      const wasOpen = this.isOpen;
      this.isOpen = false;
      if (this.mode === "native") this._setMode("closed", { reason });
      if (wasOpen) {
        this._emit("close", { mode: "native", reason });
        invokeSafely(this.onClose, { mode: "native", reason }, this);
      }
    } catch (error) { this._reportError(error); }
  }

  async close(options = {}) {
    try {
      if (this.isDestroyed && !this.isOpen) return true;
      if (!this.isOpen) return true;
      const reason = options?.reason ?? "api";
      if (this.mode === "native" && this.document?.pictureInPictureElement === this.video
        && typeof this.document.exitPictureInPicture === "function") {
        try {
          await this.document.exitPictureInPicture();
        } catch (error) {
          this._reportError(error);
          return false;
        }
      }
      if (this.mode === "fallback") {
        this._restoreVideoPosition();
        this._removeFallbackRoot();
        this.isOpen = false;
        this._setMode("closed", { reason });
        this._emit("close", { mode: "fallback", reason });
        invokeSafely(this.onClose, { mode: "fallback", reason }, this);
      } else if (this.isOpen) {
        this._handleNativeClose(reason);
      }
      return !this.isOpen;
    } catch (error) {
      this._reportError(error);
      return false;
    }
  }

  async toggle(options = {}) {
    try { return this.isOpen ? this.close(options) : this.open(options); }
    catch (error) { this._reportError(error); return false; }
  }

  async restore() {
    try {
      if (!this.isOpen) return true;
      return this.close({ reason: "restore" });
    } catch (error) { this._reportError(error); return false; }
  }

  setDockCorner(corner) {
    try {
      if (!DOCK_CORNERS.includes(corner)) return false;
      this.dockCorner = corner;
      this._applyDockStyles();
      this._emit("positionchange", { corner });
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  setPosition(corner) { return this.setDockCorner(corner); }
  getPosition() { return this.dockCorner; }

  addEventListener(type, listener) {
    try {
      const listeners = this._listeners.get(type);
      if (!listeners || typeof listener !== "function" || this.isDestroyed) return false;
      listeners.add(listener);
      return true;
    } catch (error) { this._reportError(error); return false; }
  }

  removeEventListener(type, listener) {
    try { return this._listeners.get(type)?.delete(listener) ?? false; }
    catch (error) { this._reportError(error); return false; }
  }

  _emit(type, detail) {
    try {
      const listeners = this._listeners.get(type);
      if (!listeners) return;
      for (const listener of [...listeners]) invokeSafely(listener, detail, this);
    } catch (error) { this._reportError(error); }
  }

  _restoreVideoPosition() {
    try {
      const video = this.video;
      const placeholder = this._placeholder;
      const placeholderParent = placeholder?.parentNode ?? null;
      const parent = placeholderParent ?? this._originalParent;
      const canInsert = Boolean(video && parent && typeof parent.insertBefore === "function");

      if (canInsert && video.parentNode !== parent) {
        let reference = null;
        if (placeholderParent === parent) {
          reference = placeholder;
        } else if (this._originalNextSibling && this._originalNextSibling.parentNode === parent) {
          reference = this._originalNextSibling;
        }
        try {
          parent.insertBefore(video, reference);
        } catch {
          if (reference !== null) parent.insertBefore(video, null);
        }
      }

      if (video && this._originalVideoStyle !== null && video.style) {
        video.style.cssText = this._originalVideoStyle;
      }

      if (placeholderParent && typeof placeholderParent.removeChild === "function") {
        placeholderParent.removeChild(placeholder);
      }
      this._placeholder = null;
      this._originalParent = null;
      this._originalNextSibling = null;
      this._originalVideoStyle = null;
      return true;
    } catch (error) {
      this._placeholder = null;
      this._originalParent = null;
      this._originalNextSibling = null;
      this._originalVideoStyle = null;
      this._reportError(error);
      return false;
    }
  }

  _removeFallbackRoot() {
    try {
      if (this._fallbackRoot?.parentNode && typeof this._fallbackRoot.parentNode.removeChild === "function") {
        this._fallbackRoot.parentNode.removeChild(this._fallbackRoot);
      }
      this._fallbackRoot = null;
      return true;
    } catch (error) {
      this._fallbackRoot = null;
      this._reportError(error);
      return false;
    }
  }

  _handleFullscreenChange() {
    try {
      if (this.isDestroyed || !this.isOpen || this.mode !== "fallback") return;
      if (this.document?.fullscreenElement === this.video || this.document?.fullscreenElement === this._fallbackRoot) {
        void this.close({ reason: "fullscreen" });
      }
    } catch (error) { this._reportError(error); }
  }

  destroy() {
    try {
      if (this.isDestroyed) return true;
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      this.window?.removeEventListener?.("scroll", this._boundScroll);
      this.window?.removeEventListener?.("resize", this._boundResize);
      this.video?.removeEventListener?.("enterpictureinpicture", this._boundEnterPiP);
      this.video?.removeEventListener?.("leavepictureinpicture", this._boundLeavePiP);
      this.document?.removeEventListener?.("fullscreenchange", this._boundFullscreenChange);
      if (this.mode === "fallback") {
        this._restoreVideoPosition();
        this._removeFallbackRoot();
        this.isOpen = false;
        this._setMode("closed", { reason: "destroy" });
      } else if (this.mode === "native" && this.document?.pictureInPictureElement === this.video) {
        const result = this.document.exitPictureInPicture?.();
        if (result && typeof result.catch === "function") result.catch((error) => this._reportError(error));
        this.isOpen = false;
        this._setMode("closed", { reason: "destroy" });
      }
      for (const listeners of this._listeners.values()) listeners.clear();
      this.isDestroyed = true;
      this.video = null;
      this.document = null;
      this.window = null;
      this.container = null;
      return true;
    } catch (error) {
      this._reportError(error);
      this.isDestroyed = true;
      return false;
    }
  }
}

/** Create a PiP manager without throwing in unsupported browser environments. */
export function createPipMiniPlayerManager(options = {}) {
  try {
    return new PipMiniPlayerManager(options);
  } catch {
    return null;
  }
}

export { DOCK_CORNERS };

export default Object.freeze({
  DOCK_CORNERS,
  PipMiniPlayerManager,
  createPipMiniPlayerManager,
});
