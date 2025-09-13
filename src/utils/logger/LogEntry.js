/**
 * Represents a log entry to be sent to the logging service.
 */
export class LogEntry {
  constructor({
    sessionId,
    providerId,
    appId,
    logLine,
    type,
    level,
    sensitive = false,
    source,
    tabId,
    url,
    meta,
    time = null,
    deviceId,
  }) {
    this.sessionId = sessionId;
    this.providerId = providerId;
    this.appId = appId;
    this.logLine = logLine;
    this.type = type;
    this.level = level;
    this.sensitive = sensitive;
    this.source = source;
    this.tabId = tabId;
    this.url = url;
    this.meta = meta || undefined;
    this.time = time || new Date();
    this.deviceId = deviceId;
  }

  toJson() {
    return {
      logLine: this.logLine,
      ts: LogEntry.fromDateTimeToTimeStamp(this.time),
      type: this.type,
      sessionId: this.sessionId,
      providerId: this.providerId,
      appId: this.appId,
      // Optional extra fields (server can ignore if unused)
      level: this.level,
      sensitive: this.sensitive,
      source: this.source,
      tabId: this.tabId,
      url: this.url,
      meta: this.meta,
      deviceId: this.deviceId,
    };
  }

  static fromDateTimeToTimeStamp(dateTime) {
    const ms = dateTime.getTime();
    return (ms * 1000000).toString();
  }
}
