// Local debug logger for development
// Usage: import { debugLogger, DebugLogType } from './debugLogger';

export const DebugLogType = Object.freeze({
  BACKGROUND: "background",
  CONTENT: "content",
  POPUP: "popup",
  INIT: "init",
  VERIFICATION: "verification",
  FETCH: "fetch",
  PROVIDER: "provider",
  CLAIM: "claim",
  PROOF: "proof",
  OFFSCREEN: "offscreen",
  POLYFILLS: "polyfills",
  SESSION_TIMER: "session-timer",
});

class DebugLogger {
  constructor() {
    this.enabled = true;
    this.allowedTypes = new Set(); // If empty, allow all types
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  setTypes(typesArray) {
    if (!Array.isArray(typesArray)) return;
    this.allowedTypes = new Set(typesArray);
  }

  clearTypes() {
    this.allowedTypes.clear();
  }

  log(type, ...args) {
    if (!this.enabled) return;
    if (this.allowedTypes.size > 0 && !this.allowedTypes.has(type)) return;
    const color = DebugLogger.typeColor(type);
    // eslint-disable-next-line no-console
    console.log(`%c[${type}][INFO]`, `color: ${color}; font-weight: bold;`, ...args);
  }

  info(type, ...args) {
    if (!this.enabled) return;
    if (this.allowedTypes.size > 0 && !this.allowedTypes.has(type)) return;
    const color = DebugLogger.typeColor(type);
    // eslint-disable-next-line no-console
    console.info(`%c[${type}][INFO]`, `color: ${color}; font-weight: bold;`, ...args);
  }

  warn(type, ...args) {
    if (!this.enabled) return;
    if (this.allowedTypes.size > 0 && !this.allowedTypes.has(type)) return;
    const color = DebugLogger.typeColor(type, "warn");
    // eslint-disable-next-line no-console
    console.warn(`%c[${type}][WARN]`, `color: ${color}; font-weight: bold;`, ...args);
  }

  error(type, ...args) {
    if (!this.enabled) return;
    if (this.allowedTypes.size > 0 && !this.allowedTypes.has(type)) return;
    const color = DebugLogger.typeColor(type, "error");
    // eslint-disable-next-line no-console
    console.error(`%c[${type}][ERROR]`, `color: ${color}; font-weight: bold;`, ...args);
  }

  static typeColor(type, level = "info") {
    // Assign colors to types for better visibility
    const colors = {
      background: "#0074D9",
      content: "#2ECC40",
      popup: "#FF851B",
      init: "#B10DC9",
      verification: "#FF4136",
      fetch: "#39CCCC",
      provider: "#FFDC00",
      claim: "#7FDBFF",
      proof: "#85144b",
      offscreen: "#AAAAAA",
      polyfills: "#0074D9",
      "session-timer": "#2ECC40",
    };
    const levelColors = {
      info: "", // default, use type color
      warn: "#FFA500", // orange
      error: "#FF0000", // red
    };
    // Try to match a known type, else use gray
    const key = Object.keys(colors).find((k) => type.toLowerCase().includes(k));
    let baseColor = colors[key] || "#888888";
    if (level !== "info") {
      baseColor = levelColors[level] || baseColor;
    }
    return baseColor;
  }
}

export const debugLogger = new DebugLogger();
