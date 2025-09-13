import { LOGGING_ENDPOINTS, DEFAULT_LOG_CONFIG, LOG_LEVEL } from "./constants";
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

  // Ensure stable deviceId across batches
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

  shouldLogToConsole(level, sensitive) {
    if (!this.config.consoleEnabled) return false;
    if (this.config.debugMode) return true; // print everything in debug mode
    if (sensitive && !this.config.includeSensitiveToConsole) return false;
    return level >= this.config.consoleLevel;
  }

  shouldSendToBackend(level, sensitive) {
    if (!this.config.backendEnabled) return false;
    if (sensitive && !this.config.includeSensitiveToBackend) return false;
    return level >= this.config.backendLevel;
  }

  emitToConsole(level, message, meta) {
    const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
    switch (level) {
      case LOG_LEVEL.ERROR:
        console.error(line);
        break;
      case LOG_LEVEL.WARN:
        console.warn(line);
        break;
      case LOG_LEVEL.INFO:
        console.info(line);
        break;
      default:
        console.log(line);
    }
  }

  logWithLevel(
    level,
    { sessionId, providerId, appId, message, type, sensitive = false, meta, source, tabId, url },
  ) {
    const src = source || this.config.source;

    if (this.shouldLogToConsole(level, sensitive)) {
      this.emitToConsole(level, message, meta);
    }

    if (this.shouldSendToBackend(level, sensitive)) {
      const entry = new LogEntry({
        sessionId,
        providerId,
        appId,
        logLine: message,
        type,
        level,
        sensitive,
        source: src,
        tabId,
        url,
        meta,
        time: new Date(),
      });
      this.addLog(entry);
    }
  }

  debug(opts) {
    this.logWithLevel(LOG_LEVEL.DEBUG, opts);
  }
  info(opts) {
    this.logWithLevel(LOG_LEVEL.INFO, opts);
  }
  warn(opts) {
    this.logWithLevel(LOG_LEVEL.WARN, opts);
  }
  error(opts) {
    this.logWithLevel(LOG_LEVEL.ERROR, opts);
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
      obj.deviceId = obj.deviceId || deviceId; // ensure present for server grouping
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
    // Read-only snapshot if you need it
    get context() {
      return { ...ctx };
    },

    // Update context anytime (partial updates supported)
    setContext(partial = {}) {
      Object.assign(ctx, partial);
    },

    // Level helpers
    debug(msg, opts = {}) {
      loggerService.debug({ ...ctx, message: msg, ...opts });
    },
    info(msg, opts = {}) {
      loggerService.info({ ...ctx, message: msg, ...opts });
    },
    warn(msg, opts = {}) {
      loggerService.warn({ ...ctx, message: msg, ...opts });
    },
    error(msg, opts = {}) {
      loggerService.error({ ...ctx, message: msg, ...opts });
    },
  };
};
