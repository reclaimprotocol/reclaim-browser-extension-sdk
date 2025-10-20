import { loggerService, createContextLogger } from "./LoggerService";
import { debugLogger } from "./debugLogger";

// Enable debugLogger in development, disable in production
if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production") {
  debugLogger.disable();
} else {
  debugLogger.enable();
}

export { DebugLogType } from "./debugLogger";
export { debugLogger };
export { LogEntry } from "./LogEntry";
export { loggerService, createContextLogger };
export { LOGGING_ENDPOINTS, LOG_TYPES, LOG_SOURCES, LOG_LEVEL, EVENT_TYPES } from "./constants";
