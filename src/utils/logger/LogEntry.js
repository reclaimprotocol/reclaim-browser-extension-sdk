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
    eventType,
    logLevel,
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
    this.eventType = eventType;
    this.logLevel = logLevel;
    this.source = source;
    this.tabId = tabId;
    this.url = url;
    this.meta = meta || undefined;
    this.time = time || new Date();
    this.deviceId = deviceId;
  }

  toJson() {
    const json = {
      logLine: this.logLine,
      ts: LogEntry.fromDateTimeToTimeStamp(this.time),
      logLevel: this.logLevel,
      sessionId: this.sessionId,
      providerId: this.providerId,
      appId: this.appId,
      source: this.source,
      deviceId: this.deviceId,
    };

    // Only include optional fields if they exist
    if (this.type) json.type = this.type;
    if (this.eventType) json.eventType = this.eventType;
    if (this.tabId) json.tabId = this.tabId;
    if (this.url) json.url = this.url;
    if (this.meta) json.meta = this.meta;

    return json;
  }

  static fromDateTimeToTimeStamp(dateTime) {
    const ms = dateTime.getTime();
    return (ms * 1000000).toString();
  }
}
