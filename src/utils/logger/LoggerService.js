import { LOGGING_ENDPOINTS, DEFAULT_LOG_CONFIG, LOG_LEVEL, LOG_LEVEL_MAP } from "./constants";
import { LogEntry } from "./LogEntry";

export class LoggerService {
  constructor() {
    this.logs = [];
    this.isSending = false;
    this.maxBatchSize = 20;
    this.flushInterval = 5000;
    this.flushIntervalId = null;

    this.config = { ...DEFAULT_LOG_CONFIG };
    this.deviceId = null;

    this.startFlushInterval();
  }

  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }

  startFlushInterval() {
    if (this.flushIntervalId) clearInterval(this.flushIntervalId);
    this.flushIntervalId = setInterval(() => this.flush(), this.flushInterval);
  }

  stopFlushInterval() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
  }

  async getDeviceLoggingId() {
    if (this.deviceId) return this.deviceId;
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        const result = await chrome.storage.local.get(["reclaim_device_id"]);
        if (result.reclaim_device_id) {
          this.deviceId = result.reclaim_device_id;
          return this.deviceId;
        }
      }
    } catch {}
    this.deviceId =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        await chrome.storage.local.set({ reclaim_device_id: this.deviceId });
      }
    } catch {}
    return this.deviceId;
  }

  addLog(logEntry) {
    this.logs.push(logEntry);
    if (this.logs.length >= this.maxBatchSize) this.flush();
  }

  shouldLog(requestedLevel) {
    const configLevel = LOG_LEVEL_MAP[this.config.logLevel] || LOG_LEVEL.INFO;

    // Hierarchical check: request level must be <= config level
    // If config is INFO (10), only INFO (10) passes
    // If config is DEBUG (20), INFO (10) and DEBUG (20) pass
    // If config is ALL (30), everything passes
    return requestedLevel <= configLevel;
  }

  emitToConsole(logLevel, message, meta) {
    const prefix = `[${logLevel}]`;
    const line = `${prefix} ${message}`;
    if (meta) {
      console.log(line, meta);
    } else {
      console.log(line);
    }
  }

  log({
    message,
    logLevel,
    type,
    eventType,
    meta,
    sessionId,
    providerId,
    appId,
    source,
    tabId,
    url,
  }) {
    // Validate required fields
    if (!message || !logLevel) {
      console.error("Logger: message and logLevel are required");
      return;
    }

    // Check if we should log this level
    if (!this.shouldLog(logLevel)) {
      return;
    }

    // Console output

    if (this.config.consoleEnabled) {
      this.emitToConsole(logLevel, message, meta);
    }

    // Backend logging
    const entry = new LogEntry({
      sessionId: sessionId || "unknown",
      providerId: providerId || "unknown",
      appId: appId || "unknown",
      logLine: message,
      type,
      eventType,
      logLevel,
      source: source || this.config.source,
      tabId,
      url,
      meta,
      time: new Date(),
    });
    this.addLog(entry);
  }

  async flush() {
    if (this.logs.length === 0 || this.isSending) return;

    const logsToSend = [...this.logs];
    this.logs = [];

    try {
      this.isSending = true;
      await this.sendLogs(logsToSend);
    } catch (error) {
      console.error("Error flushing logs:", error);
      this.logs = [...this.logs, ...logsToSend];
    } finally {
      this.isSending = false;
    }
  }

  async sendLogs(entries) {
    if (!entries?.length) return;

    const deviceId = await this.getDeviceLoggingId();
    const formattedLogs = entries.map((e) => {
      const obj = e.toJson();
      obj.deviceId = obj.deviceId || deviceId;
      return obj;
    });

    const body = JSON.stringify({
      logs: formattedLogs,
      source: this.config.source,
      deviceId,
    });

    const res = await fetch(LOGGING_ENDPOINTS.DIAGNOSTIC_LOGGING, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      console.error(`Failed to send ${entries.length} logs`, await res.text());
    }
  }
}

export const loggerService = new LoggerService();

// Create a scoped logger to avoid repeating context
export const createContextLogger = (initial = {}) => {
  const ctx = {
    sessionId: "unknown",
    providerId: "unknown",
    appId: "unknown",
    source: loggerService.config?.source || "reclaim-extension-sdk",
    ...initial,
  };

  return {
    get context() {
      return { ...ctx };
    },

    // Update context anytime (partial updates supported)
    setContext(partial = {}) {
      Object.assign(ctx, partial);
    },

    // Main log method - pass object with message, logLevel, and optional fields
    log(opts) {
      loggerService.log({ ...ctx, ...opts });
    },

    // Convenience methods (optional, can be removed if you only want .log())
    info(opts = {}) {
      loggerService.log({ ...ctx, logLevel: "INFO", ...opts });
    },
    debug(opts = {}) {
      loggerService.log({ ...ctx, logLevel: "DEBUG", ...opts });
    },
    all(opts = {}) {
      loggerService.log({ ...ctx, logLevel: "ALL", ...opts });
    },
    error(opts = {}) {
      loggerService.log({ ...ctx, logLevel: "ALL", ...opts });
    },
  };
};
