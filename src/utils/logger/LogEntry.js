/**
 * Represents a log entry to be sent to the logging service.
 */
export class LogEntry {
  /**
   * Creates a new LogEntry instance.
   *
   * @param {Object} options - The options for creating a log entry.
   * @param {string} options.sessionId - The session ID for the log entry.
   * @param {string} options.providerId - The provider ID for the log entry.
   * @param {string} options.appId - The application ID for the log entry.
   * @param {string} options.logLine - The log message content.
   * @param {string} options.type - The type/category of the log.
   * @param {Date} [options.time] - The timestamp of the log entry (defaults to current time).
   */
  constructor({ sessionId, providerId, appId, logLine, type, time = null }) {
    this.sessionId = sessionId;
    this.providerId = providerId;
    this.appId = appId;
    this.logLine = logLine;
    this.type = type;
    this.time = time || new Date();
  }

  /**
   * Converts the LogEntry to a JSON object for sending to the server.
   *
   * @returns {Object} The JSON representation of the log entry.
   */
  toJson() {
    return {
      logLine: this.logLine,
      ts: LogEntry.fromDateTimeToTimeStamp(this.time),
      type: this.type,
      sessionId: this.sessionId,
      providerId: this.providerId,
      appId: this.appId,
    };
  }

  /**
   * Converts a JavaScript Date object to the timestamp format expected by the server.
   *
   * @param {Date} dateTime - The date to convert.
   * @returns {string} The formatted timestamp.
   */
  static fromDateTimeToTimeStamp(dateTime) {
    const ms = dateTime.getTime();
    const ts = (ms * 1000000).toString();
    return ts;
  }

  /**
   * Creates a LogEntry from an error object.
   *
   * @param {Object} options - The options for creating a log entry from an error.
   * @param {string} options.sessionId - The session ID for the log entry.
   * @param {string} options.providerId - The provider ID for the log entry.
   * @param {string} options.appId - The application ID for the log entry.
   * @param {Error} options.error - The error object.
   * @param {string} options.type - The type/category of the log.
   * @param {string} [options.message] - Optional additional message to include with the error.
   * @returns {LogEntry} A new LogEntry instance.
   */
  static fromError({ sessionId, providerId, appId, error, type, message = "" }) {
    const stackTrace = error.stack || "";
    const errorMessage = error.message || error.toString();

    const logLine = message ? `${message}: ${errorMessage}\n${stackTrace}` : `${errorMessage}\n${stackTrace}`;

    return new LogEntry({
      sessionId,
      providerId,
      appId,
      logLine,
      type,
      time: new Date(),
    });
  }
}
