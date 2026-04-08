/**
 * LoggingHub - Centralized logging hub for background service worker
 *
 * All logs from background, content, and offscreen are routed through this hub.
 * The hub maintains session context and enriches all logs before batching and sending to API.
 */

import {
  LOGGING_ENDPOINTS,
  LOG_LEVEL,
  DEFAULT_LOG_CONFIG,
  LOG_CONFIG_STORAGE_KEY,
} from "./constants";
import {
  LOG_MAX_BATCH_SIZE,
  LOG_MAX_QUEUE_SIZE,
  LOG_FLUSH_INTERVAL_MS,
  LOG_DEDUPE_WINDOW_MS,
} from "../constants/config";

// Singleton guard to prevent multiple instances
let singletonInstance = null;

class LoggingHub {
  constructor() {
    // Return existing instance if already created
    if (singletonInstance) {
      return singletonInstance;
    }

    this.sessionContext = {
      sessionId: null,
      providerId: null,
      appId: null,
    };
    this.logs = [];
    this.deviceId = null;
    this.maxBatchSize = LOG_MAX_BATCH_SIZE;
    this.maxQueueSize = LOG_MAX_QUEUE_SIZE;
    this.flushIntervalMs = LOG_FLUSH_INTERVAL_MS;
    this.flushIntervalId = null;
    this.isFlushing = false;

    // Deduplication: Map of logHash -> timestamp (ms)
    this._recentLogHashes = new Map();
    this._dedupeWindowMs = LOG_DEDUPE_WINDOW_MS;

    // Stats tracking
    this.stats = {
      totalLogsQueued: 0,
      totalLogsSent: 0,
      totalLogsDropped: 0,
      totalDeduplicated: 0,
      flushCount: 0,
    };

    // Log config (log level + console output)
    this.config = { ...DEFAULT_LOG_CONFIG };

    // Ready promise - resolves when async init completes
    this.ready = this._init();

    singletonInstance = this;
  }

  /**
   * Run all async initialization and start flush interval
   */
  async _init() {
    await Promise.all([this._initDeviceId(), this._restoreSessionContext(), this._loadConfig()]);
    this._watchConfigChanges();
    this._startFlushInterval();
  }

  /**
   * Initialize or retrieve persistent device ID
   */
  async _initDeviceId() {
    try {
      const result = await chrome.storage.local.get("reclaim_device_id");
      if (result.reclaim_device_id) {
        this.deviceId = result.reclaim_device_id;
      } else {
        this.deviceId = `ext-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        await chrome.storage.local.set({ reclaim_device_id: this.deviceId });
      }
    } catch {
      this.deviceId = `ext-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
  }

  /**
   * Restore session context from storage (handles service worker restarts)
   */
  async _restoreSessionContext() {
    try {
      const result = await chrome.storage.session?.get("reclaim_log_session_context");
      if (result?.reclaim_log_session_context) {
        this.sessionContext = result.reclaim_log_session_context;
      }
    } catch {
      // chrome.storage.session may not be available, ignore
    }
  }

  /**
   * Load log config from storage
   */
  async _loadConfig() {
    try {
      const result = await chrome.storage.local.get(LOG_CONFIG_STORAGE_KEY);
      if (result[LOG_CONFIG_STORAGE_KEY]) {
        this.config = { ...this.config, ...result[LOG_CONFIG_STORAGE_KEY] };
      }
    } catch {
      // Storage may not be available, use defaults
    }
  }

  /**
   * Watch for config changes in storage (live sync)
   */
  _watchConfigChanges() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[LOG_CONFIG_STORAGE_KEY]) {
          const newConfig = changes[LOG_CONFIG_STORAGE_KEY].newValue;
          if (newConfig) {
            this.config = { ...this.config, ...newConfig };
          }
        }
      });
    } catch {
      // Storage may not be available
    }
  }

  /**
   * Force reload config from storage (useful for ensuring sync)
   */
  async reloadConfig() {
    await this._loadConfig();
  }

  /**
   * Set log config programmatically
   * @param {Object} config - Partial config to merge
   */
  setConfig(config) {
    this.config = { ...this.config, ...config };
    try {
      chrome.storage.local.set({ [LOG_CONFIG_STORAGE_KEY]: this.config });
    } catch {
      // Storage may not be available
    }
  }

  /**
   * Check if a log should be recorded based on level
   * @param {string} level - Log level ("ERROR" | "WARN" | "INFO" | "DEBUG")
   * @returns {boolean}
   */
  _shouldLog(level) {
    const configThreshold = LOG_LEVEL[this.config.logLevel] || LOG_LEVEL.INFO;
    const requestedLevel = LOG_LEVEL[level] || LOG_LEVEL.INFO;
    // Lower number = higher severity; log if severity <= threshold
    return requestedLevel <= configThreshold;
  }

  /**
   * Start the periodic flush interval
   */
  _startFlushInterval() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
    }
    this.flushIntervalId = setInterval(() => this.flush(), this.flushIntervalMs);

    // Also flush on service worker suspend
    try {
      chrome.runtime.onSuspend?.addListener(() => {
        this.flush();
      });
    } catch {
      // onSuspend may not be available
    }
  }

  /**
   * Set session context - called when verification starts
   * @param {Object} context
   * @param {string} context.sessionId
   * @param {string} context.providerId
   * @param {string} context.appId
   */
  setSessionContext({ sessionId, providerId, appId }) {
    this.sessionContext = {
      sessionId: sessionId || null,
      providerId: providerId || null,
      appId: appId || null,
    };

    // Persist to chrome.storage.session for service worker restart recovery
    try {
      chrome.storage.session?.set({
        reclaim_log_session_context: this.sessionContext,
      });
    } catch {
      // chrome.storage.session may not be available
    }
  }

  /**
   * Clear session context - called when session ends or fails
   */
  clearSessionContext() {
    this.sessionContext = {
      sessionId: null,
      providerId: null,
      appId: null,
    };

    try {
      chrome.storage.session?.remove("reclaim_log_session_context");
    } catch {
      // chrome.storage.session may not be available
    }
  }

  /**
   * Internal method to add a log entry
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - Log level ("ERROR" | "WARN" | "INFO" | "DEBUG")
   */
  _addLog(message, type, level = "INFO") {
    // Filter by log level
    if (!this._shouldLog(level)) {
      return;
    }

    // Console output if enabled
    if (this.config.consoleEnabled) {
      const consoleFn =
        level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
      consoleFn(`[${level}] ${message}`);
    }

    const now = Date.now();

    // Deduplication: skip if we've seen this exact log within dedupeWindowMs
    const logHash = `${message}|${type}`;
    const lastSeen = this._recentLogHashes.get(logHash);
    if (lastSeen !== undefined && now - lastSeen < this._dedupeWindowMs) {
      this.stats.totalDeduplicated++;
      return;
    }
    this._recentLogHashes.set(logHash, now);

    // Periodically prune stale entries from the dedup map (every 100 entries)
    if (this._recentLogHashes.size > 100) {
      for (const [key, ts] of this._recentLogHashes) {
        if (now - ts >= this._dedupeWindowMs) {
          this._recentLogHashes.delete(key);
        }
      }
    }

    const entry = {
      logLine: message,
      ts: String(now * 1000000), // nanoseconds for Loki
      logLevel: level,
      type: type || "unknown",
      sessionId: this.sessionContext.sessionId || "unknown",
      providerId: this.sessionContext.providerId || "unknown",
      appId: this.sessionContext.appId || "unknown",
      deviceId: this.deviceId || "unknown",
    };

    this.logs.push(entry);
    this.stats.totalLogsQueued++;

    // Drop oldest logs if queue exceeds max size (prevents OOM on API outage)
    if (this.logs.length > this.maxQueueSize) {
      const dropped = this.logs.length - this.maxQueueSize;
      this.logs = this.logs.slice(dropped);
      this.stats.totalLogsDropped += dropped;
    }

    // Trigger flush if batch size reached
    if (this.logs.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  // Public API - consistent across all loggers

  /**
   * Log an error message (highest severity - always logged)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  error(message, type) {
    this._addLog(message, type, "ERROR");
  }

  /**
   * Log a warning message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  warn(message, type) {
    this._addLog(message, type, "WARN");
  }

  /**
   * Log an info message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  info(message, type) {
    this._addLog(message, type, "INFO");
  }

  /**
   * Log a debug message (only logged when logLevel is DEBUG)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   */
  debug(message, type) {
    this._addLog(message, type, "DEBUG");
  }

  /**
   * Handle log message from remote contexts (content/offscreen)
   * Called by message router when receiving LOG_MESSAGE action
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - Log level ("ERROR" | "WARN" | "INFO" | "DEBUG")
   */
  handleRemoteLog(message, type, level = "INFO") {
    this._addLog(message, type, level);
  }

  /**
   * Flush logs to the external API
   */
  async flush() {
    if (this.logs.length === 0 || this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    const batch = this.logs.splice(0, this.logs.length);
    const batchSize = batch.length;

    try {
      const response = await fetch(LOGGING_ENDPOINTS.DIAGNOSTIC_LOGGING, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logs: batch,
          source: "browser-extension-sdk",
          deviceId: this.deviceId || "unknown",
        }),
      });

      if (!response.ok) {
        // Re-queue failed logs (prepend to maintain order), respecting max queue size
        this.logs.unshift(...batch);
        if (this.logs.length > this.maxQueueSize) {
          const dropped = this.logs.length - this.maxQueueSize;
          this.logs = this.logs.slice(dropped);
          this.stats.totalLogsDropped += dropped;
        }
        if (this.config.consoleEnabled) {
          console.error("[LoggingHub] Failed to flush logs:", response.status);
        }
      } else {
        this.stats.totalLogsSent += batchSize;
        this.stats.flushCount++;
      }
    } catch (error) {
      // Re-queue failed logs, respecting max queue size
      this.logs.unshift(...batch);
      if (this.logs.length > this.maxQueueSize) {
        const dropped = this.logs.length - this.maxQueueSize;
        this.logs = this.logs.slice(dropped);
        this.stats.totalLogsDropped += dropped;
      }
      if (this.config.consoleEnabled) {
        console.error("[LoggingHub] Error flushing logs:", error);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Force immediate flush (useful for cleanup)
   */
  async forceFlush() {
    await this.flush();
  }

  /**
   * Get logging statistics
   * @returns {Object} Stats object with counts
   */
  getStats() {
    return {
      ...this.stats,
      pendingLogs: this.logs.length,
      sessionId: this.sessionContext.sessionId,
    };
  }

  /**
   * Cleanup - stop interval and flush remaining logs
   */
  async destroy() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
    await this.flush();
  }
}

// Export singleton instance for background use
export const loggingHub = new LoggingHub();

// Export class for testing
export { LoggingHub };
