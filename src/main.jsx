import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ErrorBoundaryTelemetry } from "./features/errorBoundaryTelemetry.js";
import "./index.css";

const GLOBAL_GUARD_KEY = Symbol.for("trick-a4if-tube.global-error-guards");
const ROOT_CONTAINER_ID = "root";

function safelyCall(callback, fallback = null) {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function getWindowTarget() {
  return safelyCall(() => (typeof window !== "undefined" ? window : null));
}

/** A local diagnostic collector for uncaught browser errors and rejections. */
export const globalErrorTelemetry = safelyCall(
  () => new ErrorBoundaryTelemetry({ maxErrors: 250 }),
  null,
);

/** Attach idempotent browser-level guards without suppressing normal reporting. */
export function attachGlobalErrorGuards(target = getWindowTarget()) {
  try {
    if (!target || typeof target.addEventListener !== "function"
      || typeof target.removeEventListener !== "function") return () => false;

    const existing = safelyCall(() => target[GLOBAL_GUARD_KEY], null);
    if (existing?.detach instanceof Function) return existing.detach;

    const onError = (event) => {
      safelyCall(() => globalErrorTelemetry?.capture(event?.error ?? event, {
        name: event?.error?.name ?? "Error",
        message: event?.error?.message ?? event?.message ?? "Uncaught browser error",
        source: "window.error",
        context: {
          filename: typeof event?.filename === "string" ? event.filename.slice(0, 2048) : "",
          line: Number.isFinite(event?.lineno) ? event.lineno : 0,
          column: Number.isFinite(event?.colno) ? event.colno : 0,
        },
      }));
    };

    const onUnhandledRejection = (event) => {
      const reason = event?.reason;
      safelyCall(() => globalErrorTelemetry?.capture(reason, {
        name: reason?.name ?? "UnhandledRejection",
        message: reason?.message ?? (typeof reason === "string" ? reason : "Unhandled promise rejection"),
        source: "window.unhandledrejection",
      }));
    };

    target.addEventListener("error", onError);
    target.addEventListener("unhandledrejection", onUnhandledRejection);

    let attached = true;
    const detach = () => {
      if (!attached) return false;
      attached = false;
      safelyCall(() => target.removeEventListener("error", onError));
      safelyCall(() => target.removeEventListener("unhandledrejection", onUnhandledRejection));
      safelyCall(() => {
        if (target[GLOBAL_GUARD_KEY]?.detach === detach) delete target[GLOBAL_GUARD_KEY];
      });
      return true;
    };

    safelyCall(() => Object.defineProperty(target, GLOBAL_GUARD_KEY, {
      configurable: true,
      value: Object.freeze({ detach }),
    }));
    return detach;
  } catch {
    return () => false;
  }
}

export const detachGlobalErrorGuards = attachGlobalErrorGuards();

let mountedRoot = null;

/** Mount the application into an explicit container or the document's #root. */
export function mountApp(container = safelyCall(() => document.getElementById(ROOT_CONTAINER_ID))) {
  try {
    if (!container || typeof container !== "object") return null;
    if (!mountedRoot) mountedRoot = createRoot(container);
    mountedRoot.render(<App />);
    return mountedRoot;
  } catch (error) {
    safelyCall(() => globalErrorTelemetry?.capture(error, { source: "React application mount" }));
    return null;
  }
}

/** Unmount React and release global error listeners; safe to call repeatedly. */
export function unmountApp() {
  try {
    if (mountedRoot) {
      mountedRoot.unmount();
      mountedRoot = null;
    }
    detachGlobalErrorGuards();
    return true;
  } catch (error) {
    safelyCall(() => globalErrorTelemetry?.capture(error, { source: "React application unmount" }));
    mountedRoot = null;
    return false;
  }
}

export function getMountedRoot() {
  return mountedRoot;
}

// Importing the Vite entry point starts the UI only when a root element exists.
export const root = mountApp();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unmountApp();
    safelyCall(() => globalErrorTelemetry?.destroy?.());
  });
}

export default root;
