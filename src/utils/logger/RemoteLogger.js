/**
 * RemoteLogger - logging client for content scripts and offscreen documents
 *
 * Two jobs:
 *  1. Forward every log to the background LoggingHub, which enriches it with
 *     session context and batches it to the API.
 *  2. Mirror it to the *local* console of this context, when enabled.
 *
 * (2) matters for debugging: without it, an offscreen document's logs only ever
 * appear in the service worker's console (via the hub), and vanish entirely if
 * the worker is asleep or the sendMessage fails. Mirroring locally means the
 * offscreen document's own DevTools console shows offscreen logs, and the page
 * console shows content-script logs — independent of the worker's state.
 *
 * Where to look:
 *  - service worker  → chrome://extensions → the extension → "service worker"
 *  - offscreen doc   → chrome://extensions → the extension → "Inspect views:
 *                      offscreen/offscreen.html"
 *  - content script  → the provider tab's own DevTools console
 */

import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants";
import {
  DEFAULT_LOG_CONFIG,
  LOG_CONFIG_STORAGE_KEY,
  LOG_LEVEL,
  normalizeLogLevel,
} from "./constants";
import { redact } from "./redact.js";

class RemoteLogger {
  /**
   * Create a RemoteLogger instance
   * @param {string} source - Source identifier ('content' | 'offscreen')
   */
  constructor(source) {
    this.source = source;

    // Start from the defaults so logs emitted before storage resolves are not
    // silently dropped, then reconcile with the stored config.
    this.config = { ...DEFAULT_LOG_CONFIG };
    this._loadConfig();
    this._watchConfig();
  }

  async _loadConfig() {
    try {
      const stored = await chrome.storage?.local?.get(LOG_CONFIG_STORAGE_KEY);
      if (stored?.[LOG_CONFIG_STORAGE_KEY]) {
        this.config = { ...this.config, ...stored[LOG_CONFIG_STORAGE_KEY] };
      }
    } catch {
      // chrome.storage may be unavailable in this context; keep defaults.
    }
  }

  _watchConfig() {
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area === "local" && changes[LOG_CONFIG_STORAGE_KEY]?.newValue) {
          this.config = { ...this.config, ...changes[LOG_CONFIG_STORAGE_KEY].newValue };
        }
      });
    } catch {
      // Storage may not be available.
    }
  }

  _shouldLog(level) {
    const threshold = LOG_LEVEL[normalizeLogLevel(this.config.logLevel)] || LOG_LEVEL.INFO;
    return (LOG_LEVEL[normalizeLogLevel(level)] || LOG_LEVEL.INFO) <= threshold;
  }

  /**
   * Mirror to this context's console. Returns whether it actually printed, so
   * the send-failure path knows if the line has been surfaced anywhere.
   *
   * The payload is redacted here unless the level is FINE, matching the hub:
   * one threshold decides both what is emitted and whether values are raw, so
   * enabling this console can never reveal more than the endpoint holds. It is
   * still passed as a live object (a redacted copy at INFO) so devtools renders
   * an inspectable tree.
   * @returns {boolean}
   */
  _console(message, type, level, payload) {
    if (!this.config.consoleEnabled || !this._shouldLog(level)) return false;
    const resolved = normalizeLogLevel(level);
    const fn =
      resolved === "SEVERE" ? console.error : resolved === "WARNING" ? console.warn : console.log;
    const prefix = `[${resolved}] [${this.source}]${type ? ` [${type}]` : ""} ${message}`;
    const shown =
      payload !== undefined && normalizeLogLevel(this.config.logLevel) !== "FINE"
        ? redact(payload)
        : payload;
    if (payload !== undefined) {
      fn(prefix, shown);
    } else {
      fn(prefix);
    }
    return true;
  }

  /**
   * Send log to background hub, and mirror to this context's console.
   *
   * Forwarding is unconditional — the hub owns the remote threshold. Filtering
   * here on the console threshold would mean turning the console down also
   * shrank the diagnostic dump, which is the opposite of what it should do.
   *
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - Log level ("ERROR" | "WARN" | "INFO" | "DEBUG")
   * @param {Object} [options] - `{ eventType, payload }`. `payload` is sent as
   *   an object (chrome messaging structured-clones it) so the hub can redact it
   *   for the endpoint while both consoles show the real values.
   */
  _sendLog(message, type, level = "INFO", options = undefined) {
    const { payload } = options || {};
    const mirrored = this._console(message, type, level, payload);

    // Last resort when the hub is unreachable: surface the line locally, but
    // only if the mirror above did not already print it.
    const fallback = () => {
      if (!mirrored) {
        console.log(`[${level}] [${this.source}]${type ? ` [${type}]` : ""} ${message}`);
      }
    };

    try {
      const sending = chrome.runtime.sendMessage({
        action: MESSAGE_ACTIONS.LOG_MESSAGE,
        source:
          this.source === "content" ? MESSAGE_SOURCES.CONTENT_SCRIPT : MESSAGE_SOURCES.OFFSCREEN,
        target: MESSAGE_SOURCES.BACKGROUND,
        data: {
          message,
          type,
          source: this.source,
          level,
          options,
        },
      });
      // MV2/Firefox callback-style sendMessage returns undefined, not a promise.
      if (sending?.catch) sending.catch(fallback);
    } catch {
      fallback();
    }
  }

  /**
   * Relay a log that originated in another context, preserving its own
   * identity instead of re-labelling it as this logger's source.
   *
   * Used by the content script for MAIN-world logs arriving over the
   * RECLAIM_LOG bridge: those come from "interceptor"/"injection", and
   * attributing them to "content" would hide where interception actually
   * failed.
   *
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - Log level
   * @param {string} context - Originating context ("interceptor" | "injection")
   */
  relay(message, type, level = "INFO", context = "page", options = undefined) {
    try {
      const sending = chrome.runtime.sendMessage({
        action: MESSAGE_ACTIONS.LOG_MESSAGE,
        source: MESSAGE_SOURCES.CONTENT_SCRIPT,
        target: MESSAGE_SOURCES.BACKGROUND,
        data: { message, type, source: context, level, options },
      });
      if (sending?.catch) sending.catch(() => {});
    } catch {
      // Background unreachable; the page console already showed this line.
    }
  }

  /**
   * Log an error message (highest severity - always logged)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`
   */
  error(message, type, options) {
    this._sendLog(message, type, "SEVERE", options);
  }

  /**
   * Log a warning message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  warn(message, type, options) {
    this._sendLog(message, type, "WARNING", options);
  }

  /**
   * Log an info message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  info(message, type, options) {
    this._sendLog(message, type, "INFO", options);
  }

  /**
   * Log at FINE — emitted only when `logLevel` is FINE, which is also the level
   * at which payload values are kept raw.
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  debug(message, type, options) {
    this._sendLog(message, type, "FINE", options);
  }

  /** @see debug - alias spelled the way the platform spells the level. */
  fine(message, type, options) {
    this._sendLog(message, type, "FINE", options);
  }
}

/**
 * Create a RemoteLogger instance for a specific source
 * @param {string} source - Source identifier ('content' | 'offscreen')
 * @returns {RemoteLogger}
 */
export function createRemoteLogger(source) {
  return new RemoteLogger(source);
}

// Export class for testing
export { RemoteLogger };
