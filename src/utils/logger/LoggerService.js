import { LOGGING_ENDPOINTS } from "./constants";
import { LogEntry } from "./LogEntry";

/**
 * Logger service for sending diagnostic logs to the server.
 */
export class LoggerService {
  constructor() {
    this.logs = [];
    this.isSending = false;
    this.maxBatchSize = 20;
    this.flushInterval = 5000; // 5 seconds
    this.flushIntervalId = null;
    this.deviceId = null;

    // Start the flush interval
    this.startFlushInterval();
  }

  /**
   * Start the interval timer to periodically flush logs.
   */
  startFlushInterval() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
    }

    this.flushIntervalId = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }

  /**
   * Stop the interval timer.
   */
  stopFlushInterval() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
  }

  /**
   * Add a log entry to the queue.
   *
   * @param {LogEntry} logEntry - The log entry to add.
   */
  addLog(logEntry) {
    this.logs.push(logEntry);

    // If we've reached the max batch size, flush immediately
    if (this.logs.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  /**
   * Log a message.
   *
   * @param {Object} options - The log options.
   * @param {string} options.sessionId - The session ID.
   * @param {string} options.providerId - The provider ID.
   * @param {string} options.appId - The application ID.
   * @param {string} options.message - The message to log.
   * @param {string} options.type - The type/category of the log.
   */
  log({ sessionId, providerId, appId, message, type, source, tabId, url }) {
    const logEntry = new LogEntry({
      sessionId,
      providerId,
      appId,
      logLine: message,
      type,
      source,
      tabId,
      url,
      time: new Date(),
    });

    this.addLog(logEntry);
  }

  /**
   * Log an error.
   *
   * @param {Object} options - The error log options.
   * @param {string} options.sessionId - The session ID.
   * @param {string} options.providerId - The provider ID.
   * @param {string} options.appId - The application ID.
   * @param {Error} options.error - The error object.
   * @param {string} options.type - The type/category of the log.
   * @param {string} [options.message] - Optional message to include with the error.
   */
  logError({ sessionId, providerId, appId, error, type, message, source, tabId, url }) {
    const stackTrace = error.stack || "";
    const errorMessage = error.message || error.toString();

    const logLine = message
      ? `${message}: ${errorMessage}\n${stackTrace}`
      : `${errorMessage}\n${stackTrace}`;

    const logEntry = new LogEntry({
      sessionId,
      providerId,
      appId,
      logLine,
      type,
      source,
      tabId,
      url,
      time: new Date(),
    });

    this.addLog(logEntry);
  }

  /**
   * Get the device ID for logging (persistent).
   *
   * @returns {Promise<string>} The device ID.
   */
  async getDeviceLoggingId() {
    if (this.deviceId) {
      return this.deviceId;
    }

    // Try to get from storage first
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        const result = await chrome.storage.local.get(["reclaim_device_id"]);
        if (result.reclaim_device_id) {
          this.deviceId = result.reclaim_device_id;
          return this.deviceId;
        }
      }
    } catch (error) {
      console.warn("Failed to get device ID from storage:", error);
    }

    // Generate new device ID
    this.deviceId = crypto.randomUUID();

    // Store for future use
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        await chrome.storage.local.set({ reclaim_device_id: this.deviceId });
      }
    } catch (error) {
      console.warn("Failed to store device ID:", error);
    }
    return this.deviceId;
  }

  /**
   * Flush the log queue and send logs to the server.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.logs.length === 0 || this.isSending) {
      return;
    }

    const logsToSend = [...this.logs];
    this.logs = [];

    try {
      this.isSending = true;
      await this.sendLogs(logsToSend);
    } catch (error) {
      console.error("Error flushing logs:", error);

      // Put logs back in queue if sending failed
      this.logs = [...this.logs, ...logsToSend];
    } finally {
      this.isSending = false;
    }
  }

  /**
   * Get the device ID for logging.
   *
   * @returns {Promise<string>} The device ID.
   */
  async getDeviceLoggingId() {
    // generate a random unique id
    const deviceId = crypto.randomUUID();

    return deviceId;
  }

  /**
   * Send logs to the server.
   *
   * @param {LogEntry[]} entries - The log entries to send.
   * @returns {Promise<void>}
   */
  async sendLogs(entries) {
    try {
      if (!entries || entries.length === 0) {
        return;
      }

      const formattedLogs = entries.map((entry) => entry.toJson());

      const body = JSON.stringify({
        logs: formattedLogs,
        source: "reclaim-extension",
        deviceId: await this.getDeviceLoggingId(),
      });

      const response = await fetch(LOGGING_ENDPOINTS.DIAGNOSTIC_LOGGING, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        console.error(
          `Failed to send ${entries.length} logs [${new Blob([body]).size} B] (batch ${entries.length})`,
          await response.text(),
        );
      }
    } catch (error) {
      console.error(`Failed to send logs (batch ${entries.length})`, error);
    }
  }
}

// Create a singleton instance of the logger service
export const loggerService = new LoggerService();
