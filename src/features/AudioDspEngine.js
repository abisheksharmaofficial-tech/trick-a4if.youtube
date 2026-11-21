const freezeBand = (frequency, type, q = 0.8) => Object.freeze({ frequency, type, q });
const freezeGains = (values) => Object.freeze({ ...values });

const DEFAULT_GAINS = freezeGains({
  bassBoost: 0,
  trebleBoost: 0,
  vocalBoost: 0,
});

/** Built-in equalizer and enhancement settings, expressed in decibels. */
export const AUDIO_DSP_PRESETS = Object.freeze({
  flat: Object.freeze({
    label: "Flat",
    bands: freezeGains({ bass: 0, lowMid: 0, mid: 0, presence: 0, brilliance: 0, treble: 0 }),
    gains: DEFAULT_GAINS,
  }),
  bass: Object.freeze({
    label: "Bass Boost",
    bands: freezeGains({ bass: 5, lowMid: 2, mid: 0, presence: 0, brilliance: 0, treble: 0 }),
    gains: freezeGains({ bassBoost: 4, trebleBoost: 0, vocalBoost: 0 }),
  }),
  treble: Object.freeze({
    label: "Treble Boost",
    bands: freezeGains({ bass: 0, lowMid: 0, mid: 0, presence: 2, brilliance: 4, treble: 5 }),
    gains: freezeGains({ bassBoost: 0, trebleBoost: 3, vocalBoost: 0 }),
  }),
  vocal: Object.freeze({
    label: "Vocal Clarity",
    bands: freezeGains({ bass: -2, lowMid: -1, mid: 1, presence: 4, brilliance: 2, treble: 0 }),
    gains: freezeGains({ bassBoost: 0, trebleBoost: 0, vocalBoost: 3 }),
  }),
  rock: Object.freeze({
    label: "Rock",
    bands: freezeGains({ bass: 4, lowMid: 1, mid: -1, presence: 2, brilliance: 3, treble: 2 }),
    gains: DEFAULT_GAINS,
  }),
  pop: Object.freeze({
    label: "Pop",
    bands: freezeGains({ bass: 1, lowMid: 0, mid: 2, presence: 2, brilliance: 1, treble: 1 }),
    gains: DEFAULT_GAINS,
  }),
  jazz: Object.freeze({
    label: "Jazz",
    bands: freezeGains({ bass: 2, lowMid: 1, mid: -1, presence: 2, brilliance: 1, treble: 2 }),
    gains: DEFAULT_GAINS,
  }),
});

const BAND_DEFINITIONS = Object.freeze([
  freezeBand(60, "lowshelf"),
  freezeBand(250, "peaking", 1),
  freezeBand(1000, "peaking", 1),
  freezeBand(3000, "peaking", 1),
  freezeBand(6000, "peaking", 1),
  freezeBand(12000, "highshelf"),
]);
const BAND_NAMES = Object.freeze(["bass", "lowMid", "mid", "presence", "brilliance", "treble"]);
const MAX_GAIN_DB = 12;
const MIN_GAIN_DB = -12;
const MAX_COMBINED_GAIN_DB = 24;
const mediaSources = new WeakMap();

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeGain(value) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, MIN_GAIN_DB, MAX_GAIN_DB) : 0;
}

function setParam(param, value, context) {
  try {
    if (!param || !Number.isFinite(value)) return false;
    const now = Number.isFinite(context?.currentTime) ? context.currentTime : 0;
    if (typeof param.cancelScheduledValues === "function") param.cancelScheduledValues(now);
    if (typeof param.setTargetAtTime === "function") param.setTargetAtTime(value, now, 0.015);
    else param.value = value;
    return true;
  } catch {
    return false;
  }
}

function resolvePreset(preset) {
  if (typeof preset === "string") return AUDIO_DSP_PRESETS[preset.toLocaleLowerCase()] ?? null;
  if (!preset || typeof preset !== "object") return null;
  return preset;
}

/**
 * Web Audio equalizer and enhancement graph for an HTML media element.
 * AudioContext creation is deferred until connect(), allowing safe use in
 * server-rendered and non-browser environments.
 */
export class AudioDspEngine {
  constructor(options = {}) {
    this.options = options && typeof options === "object" ? options : {};
    this.context = this.options.context ?? null;
    this.destination = this.options.destination ?? null;
    this.mediaElement = this.options.mediaElement ?? this.options.element ?? null;
    this.preset = "flat";
    this.gains = { ...DEFAULT_GAINS };
    this.bypassed = Boolean(this.options.bypassed);
    this.connected = false;
    this.destroyed = false;
    this.lastError = null;
    this._ownsContext = false;
    this._source = null;
    this._nodes = [];
    this._filters = [];
    this._dryGain = null;
    this._wetGain = null;
    this._outputGain = null;
    this._compressor = null;

    try {
      if (this.options.preset) this.setPreset(this.options.preset);
      if (this.options.gains) this.setGains(this.options.gains);
      if (this.options.autoConnect === true && this.mediaElement) this.connect();
    } catch (error) {
      this.lastError = error;
    }
  }

  /** Connect a media/video element once to the configured AudioContext graph. */
  connect(mediaElement = this.mediaElement) {
    try {
      if (this.destroyed || !mediaElement || typeof mediaElement !== "object") return false;
      if (this.connected) return mediaElement === this.mediaElement;

      let context = this.context;
      if (!context) {
        const AudioContextConstructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (typeof AudioContextConstructor !== "function") return false;
        context = new AudioContextConstructor();
        this.context = context;
        this._ownsContext = true;
      }

      if (typeof context.createMediaElementSource !== "function"
        || typeof context.createBiquadFilter !== "function"
        || typeof context.createGain !== "function") return false;

      const existingSource = mediaSources.get(mediaElement);
      if (existingSource && existingSource.context === context) return false;

      const source = context.createMediaElementSource(mediaElement);
      const filters = BAND_DEFINITIONS.map(({ frequency, type, q }) => {
        const filter = context.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = frequency;
        filter.Q.value = q;
        return filter;
      });
      const dryGain = context.createGain();
      const wetGain = context.createGain();
      const outputGain = context.createGain();
      const destination = this.destination ?? context.destination;
      if (!destination || typeof source.connect !== "function") {
        try { source.disconnect(); } catch { /* Best effort rollback. */ }
        return false;
      }

      const nodes = [source, ...filters, dryGain, wetGain, outputGain];
      let compressor = null;
      if (typeof context.createDynamicsCompressor === "function") {
        try {
          compressor = context.createDynamicsCompressor();
          nodes.push(compressor);
        } catch {
          compressor = null;
        }
      }

      source.connect(dryGain);
      dryGain.connect(outputGain);
      source.connect(filters[0]);
      for (let index = 0; index < filters.length - 1; index += 1) filters[index].connect(filters[index + 1]);
      filters[filters.length - 1].connect(wetGain);
      if (compressor) {
        wetGain.connect(compressor);
        compressor.connect(outputGain);
      } else {
        wetGain.connect(outputGain);
      }
      outputGain.connect(destination);

      this.mediaElement = mediaElement;
      this._source = source;
      this._filters = filters;
      this._dryGain = dryGain;
      this._wetGain = wetGain;
      this._outputGain = outputGain;
      this._compressor = compressor;
      this._nodes = nodes;
      mediaSources.set(mediaElement, { context, source });
      this.connected = true;
      this.setBypass(this.bypassed);
      this._applySettings();

      if (context.state === "suspended" && typeof context.resume === "function") {
        const resumeResult = context.resume();
        if (resumeResult && typeof resumeResult.catch === "function") resumeResult.catch(() => {});
      }
      return true;
    } catch (error) {
      this.lastError = error;
      this._disconnectGraph();
      return false;
    }
  }

  /** Enable or disable equalization while preserving a direct dry audio path. */
  setBypass(bypassed = true) {
    try {
      this.bypassed = Boolean(bypassed);
      if (!this.connected) return true;
      const now = this.context?.currentTime;
      const dry = this.bypassed ? 1 : 0;
      const wet = this.bypassed ? 0 : 1;
      const dryOk = setParam(this._dryGain?.gain, dry, this.context);
      const wetOk = setParam(this._wetGain?.gain, wet, this.context);
      if (Number.isFinite(now)) {
        try {
          this._dryGain?.gain?.setValueAtTime?.(dry, now);
          this._wetGain?.gain?.setValueAtTime?.(wet, now);
        } catch { /* The target ramp above remains the fallback. */ }
      }
      return dryOk && wetOk;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  /** Apply a named built-in preset or a custom preset object. */
  setPreset(preset) {
    try {
      const resolved = resolvePreset(preset);
      if (!resolved) return false;

      const nextBands = {};
      for (const name of BAND_NAMES) nextBands[name] = normalizeGain(resolved.bands?.[name] ?? 0);
      const nextGains = {};
      for (const name of Object.keys(DEFAULT_GAINS)) {
        nextGains[name] = normalizeGain(resolved.gains?.[name] ?? this.gains[name] ?? 0);
      }

      this._presetBands = nextBands;
      this.gains = nextGains;
      this.preset = typeof preset === "string" ? preset.toLocaleLowerCase() : (resolved.label ?? "custom");
      this._applySettings();
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  /** Update one or more enhancement gains in decibels. */
  setGains(gains = {}) {
    try {
      if (!gains || typeof gains !== "object" || Array.isArray(gains)) return false;
      for (const name of Object.keys(DEFAULT_GAINS)) {
        if (Object.prototype.hasOwnProperty.call(gains, name)) this.gains[name] = normalizeGain(gains[name]);
      }
      this._applySettings();
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  /** Update a single enhancement gain; unknown gain names are rejected. */
  setGain(name, value) {
    try {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_GAINS, name)) return false;
      return this.setGains({ [name]: value });
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  /** Return current effective band settings without exposing mutable internals. */
  getSettings() {
    try {
      return Object.freeze({
        preset: this.preset,
        gains: Object.freeze({ ...this.gains }),
        bypassed: this.bypassed,
        connected: this.connected,
        destroyed: this.destroyed,
      });
    } catch {
      return null;
    }
  }

  _applySettings() {
    try {
      if (!this._filters.length) return true;
      const bands = this._presetBands ?? {};
      const bass = this.gains.bassBoost ?? 0;
      const treble = this.gains.trebleBoost ?? 0;
      const vocal = this.gains.vocalBoost ?? 0;
      const offsets = [bass, 0, 0, vocal, treble * 0.5, treble];

      return this._filters.every((filter, index) => {
        const base = bands[BAND_NAMES[index]] ?? 0;
        let gain = base + offsets[index];
        if (index === 0) gain += bass;
        if (index === 5) gain += treble;
        if (index === 3) gain += vocal;
        gain = clamp(gain, -MAX_COMBINED_GAIN_DB, MAX_COMBINED_GAIN_DB);
        return setParam(filter.gain, gain, this.context);
      });
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  _disconnectGraph() {
    try {
      for (const node of this._nodes) {
        try { node?.disconnect?.(); } catch { /* Continue cleaning the remaining nodes. */ }
      }
      if (this.mediaElement && mediaSources.get(this.mediaElement)?.source === this._source) {
        mediaSources.delete(this.mediaElement);
      }
      this._nodes = [];
      this._filters = [];
      this._source = null;
      this._dryGain = null;
      this._wetGain = null;
      this._outputGain = null;
      this._compressor = null;
      this.connected = false;
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  /** Disconnect nodes and close only an AudioContext created by this engine. */
  destroy() {
    try {
      if (this.destroyed) return true;
      this._disconnectGraph();
      if (this._ownsContext && this.context && this.context.state !== "closed"
        && typeof this.context.close === "function") {
        const closeResult = this.context.close();
        if (closeResult && typeof closeResult.catch === "function") closeResult.catch(() => {});
      }
      this.context = null;
      this.destination = null;
      this.mediaElement = null;
      this.destroyed = true;
      return true;
    } catch (error) {
      this.lastError = error;
      this.destroyed = true;
      return false;
    }
  }
}

/** Create an engine without throwing in unsupported browser environments. */
export function createAudioDspEngine(options = {}) {
  try {
    return new AudioDspEngine(options);
  } catch {
    return null;
  }
}

export default Object.freeze({
  AUDIO_DSP_PRESETS,
  AudioDspEngine,
  createAudioDspEngine,
});
