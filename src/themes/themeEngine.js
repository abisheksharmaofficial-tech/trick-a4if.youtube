const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toFiniteNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const freezeTokens = (tokens) => Object.freeze(tokens);

export const THEMES = Object.freeze({
  dark: freezeTokens({
    colorScheme: "dark",
    background: "#090b10",
    surface: "#11151d",
    surfaceElevated: "#191f2a",
    text: "#f4f6fb",
    textMuted: "#a4adbd",
    border: "#293140",
    accent: "#ff3b30",
    accentText: "#ffffff",
    success: "#42c982",
    warning: "#ffc857",
    error: "#ff6b6b",
    shadow: "0 12px 32px rgb(0 0 0 / 32%)",
  }),
  light: freezeTokens({
    colorScheme: "light",
    background: "#f5f7fb",
    surface: "#ffffff",
    surfaceElevated: "#ffffff",
    text: "#171b24",
    textMuted: "#626d7d",
    border: "#dce2eb",
    accent: "#e52d25",
    accentText: "#ffffff",
    success: "#16834f",
    warning: "#946000",
    error: "#c62828",
    shadow: "0 12px 32px rgb(25 35 50 / 12%)",
  }),
});

const normalizeMode = (mode) => (mode === "light" ? "light" : "dark");

/**
 * Resolves Eye Protection settings.
 * `warmth` is a percentage from 0 to 100. In adaptive mode, a supplied
 * `ambientLevel` from 0 (dark) to 100 (bright) scales warmth upward in dim
 * conditions and downward in bright conditions. No device sensor is assumed.
 */
function resolveEyeProtection(eyeProtection) {
  try {
    if (eyeProtection === true) {
      return { enabled: true, warmth: 50, adaptive: false };
    }
    if (!eyeProtection || typeof eyeProtection !== "object") {
      return { enabled: false, warmth: 0, adaptive: false };
    }

    const configuredWarmth = clamp(toFiniteNumber(eyeProtection.warmth, 0), 0, 100);
    const adaptive = eyeProtection.adaptive === true || eyeProtection.mode === "adaptive";
    const ambientLevel = Number(eyeProtection.ambientLevel);
    const hasAmbientLevel = Number.isFinite(ambientLevel);
    const warmth = adaptive && hasAmbientLevel
      ? clamp(configuredWarmth * (1.5 - clamp(ambientLevel, 0, 100) / 100), 0, 100)
      : configuredWarmth;

    return {
      enabled: eyeProtection.enabled !== false && warmth > 0,
      warmth,
      adaptive,
    };
  } catch {
    return { enabled: false, warmth: 0, adaptive: false };
  }
}

/** Return theme tokens augmented with the resolved Eye Protection settings. */
export function getThemeTokens(mode = "dark", eyeProtection = null) {
  try {
    const theme = THEMES[normalizeMode(mode)];
    const eye = resolveEyeProtection(eyeProtection);
    const intensity = eye.enabled ? eye.warmth / 100 : 0;

    return Object.freeze({
      ...theme,
      eyeProtection: Object.freeze({
        enabled: eye.enabled,
        warmth: eye.warmth,
        adaptive: eye.adaptive,
        overlayOpacity: Number((intensity * 0.22).toFixed(3)),
        filter: getEyeProtectionFilterCss(eyeProtection),
      }),
    });
  } catch {
    return Object.freeze({
      ...THEMES.dark,
      eyeProtection: Object.freeze({ enabled: false, warmth: 0, adaptive: false, overlayOpacity: 0, filter: "none" }),
    });
  }
}

/**
 * Returns a conservative CSS filter string for warmth. A separate low-opacity
 * amber overlay is applied by `applyThemeToDocument` to avoid filtering media.
 */
export function getEyeProtectionFilterCss(eyeProtection = null) {
  try {
    const eye = resolveEyeProtection(eyeProtection);
    if (!eye.enabled || eye.warmth <= 0) return "none";

    const intensity = eye.warmth / 100;
    const sepia = (intensity * 0.32).toFixed(3);
    const saturation = (1 + intensity * 0.08).toFixed(3);
    return `sepia(${sepia}) saturate(${saturation})`;
  } catch {
    return "none";
  }
}

const CSS_VARIABLES = Object.freeze({
  background: "--tat-background",
  surface: "--tat-surface",
  surfaceElevated: "--tat-surface-elevated",
  text: "--tat-text",
  textMuted: "--tat-text-muted",
  border: "--tat-border",
  accent: "--tat-accent",
  accentText: "--tat-accent-text",
  success: "--tat-success",
  warning: "--tat-warning",
  error: "--tat-error",
  shadow: "--tat-shadow",
});

const OVERLAY_STYLE_ID = "tat-eye-protection-overlay-style";
const OVERLAY_CLASS = "tat-eye-protection-overlay";

/** Apply theme CSS variables and a non-interactive warmth overlay to a document. */
export function applyThemeToDocument(mode = "dark", eyeProtection = null, targetDoc = globalThis.document) {
  try {
    const doc = targetDoc;
    const root = doc?.documentElement;
    if (!root || !root.style || typeof root.setAttribute !== "function") return false;

    const selectedMode = normalizeMode(mode);
    const tokens = getThemeTokens(selectedMode, eyeProtection);
    const eye = tokens.eyeProtection;

    root.setAttribute("data-theme", selectedMode);
    root.style.colorScheme = tokens.colorScheme;
    for (const [tokenName, variableName] of Object.entries(CSS_VARIABLES)) {
      root.style.setProperty(variableName, tokens[tokenName]);
    }
    root.style.setProperty("--tat-eye-warmth", `${eye.warmth}%`);
    root.style.setProperty("--tat-eye-overlay-opacity", String(eye.overlayOpacity));
    root.style.setProperty("--tat-eye-filter", eye.filter);
    root.classList?.toggle(OVERLAY_CLASS, eye.enabled);

    const head = doc.head;
    if (head && typeof doc.createElement === "function") {
      let styleElement = doc.getElementById?.(OVERLAY_STYLE_ID);
      if (!styleElement) {
        styleElement = doc.createElement("style");
        styleElement.id = OVERLAY_STYLE_ID;
        head.appendChild(styleElement);
      }
      styleElement.textContent = `.${OVERLAY_CLASS}::after{content:"";position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:rgba(255,170,75,var(--tat-eye-overlay-opacity,0));mix-blend-mode:soft-light;}`;
    }
    return true;
  } catch {
    return false;
  }
}

export default Object.freeze({
  THEMES,
  getThemeTokens,
  getEyeProtectionFilterCss,
  applyThemeToDocument,
});
