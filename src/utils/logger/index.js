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
export { loggerService };
export { LOGGING_ENDPOINTS, LOG_TYPES } from "./constants";

/**
 * Convenience function to log a message.
 *
 * @param {string} message - The message to log
 * @param {string} type - The type/category of the log
 * @param {string} sessionId - The session ID
 * @param {string} providerId - The provider ID
 * @param {string} appId - The application ID
 */
export function log(message, type, sessionId, providerId, appId) {
  const logger = createContextLogger({
    sessionId: sessionId || "unknown",
    providerId: providerId || "unknown",
    appId: appId || "unknown",
    source: "reclaim-extension-sdk",
    type: type,
  });

  return logger.info(message);
}

/**
 * Convenience function to log an error.
 *
 * @param {Error} error - The error to log
 * @param {string} type - The type/category of the log
 * @param {string} sessionId - The session ID
 * @param {string} providerId - The provider ID
 * @param {string} appId - The application ID
 * @param {string} [message] - Optional message to include with the error
 */
export function logError(error, type, sessionId, providerId, appId, message) {
  const logger = createContextLogger({
    sessionId: sessionId || "unknown",
    providerId: providerId || "unknown",
    appId: appId || "unknown",
    source: "reclaim-extension-sdk",
    type: type,
  });
  return logger.error(message, { error });
}
