/**
 * RemoteLogger - Thin logging client for content scripts and offscreen documents
 *
 * Sends all logs to the background LoggingHub via chrome.runtime.sendMessage.
 * The hub enriches logs with session context before sending to the API.
 */

import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants";

class RemoteLogger {
  /**
   * Create a RemoteLogger instance
   * @param {string} source - Source identifier ('content' | 'offscreen')
   */
  constructor(source) {
    this.source = source;
  }

  /**
   * Send log to background hub
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - Log level ("ERROR" | "WARN" | "INFO" | "DEBUG")
   */
  _sendLog(message, type, level = "INFO") {
    try {
      chrome.runtime
        .sendMessage({
          action: MESSAGE_ACTIONS.LOG_MESSAGE,
          source:
            this.source === "content" ? MESSAGE_SOURCES.CONTENT_SCRIPT : MESSAGE_SOURCES.OFFSCREEN,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: {
            message,
            type,
            source: this.source,
            level,
          },
        })
        .catch(() => {
          // Background may be unavailable (service worker inactive)
          // Fallback to console
          console.log(`[${this.source}]`, message);
        });
    } catch {
      // chrome.runtime may not be available
      console.log(`[${this.source}]`, message);
    }
  }

  /**
   * Log an error message (highest severity - always logged)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  error(message, type) {
    this._sendLog(message, type, "ERROR");
  }

  /**
   * Log a warning message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  warn(message, type) {
    this._sendLog(message, type, "WARN");
  }

  /**
   * Log an info message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  info(message, type) {
    this._sendLog(message, type, "INFO");
  }

  /**
   * Log a debug message (only logged when logLevel is DEBUG)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  debug(message, type) {
    this._sendLog(message, type, "DEBUG");
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
