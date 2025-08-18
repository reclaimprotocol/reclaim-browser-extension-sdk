# Logger Utility

A utility for sending diagnostic logs to Grafana for debugging purposes. This logger is separate from the existing Reclaim session status tracking.

## Usage

```javascript
import { log, logError, loggerService } from "../utils/logger";

// Log a simple message
log(
  "Starting verification process", // message
  "background.verification", // type/category
  "abc123", // sessionId
  "provider-123", // providerId
  "0x123456789", // appId
);

// Log an error
try {
  // Some code that might throw an error
} catch (error) {
  logError(
    error, // The Error object
    "background.error", // type/category
    "abc123", // sessionId
    "provider-123", // providerId
    "0x123456789", // appId
    "Failed during verification process", // optional message
  );
}

// For advanced usage, you can use the service directly
import { loggerService, LogEntry } from "../utils/logger";

const customLogEntry = new LogEntry({
  sessionId: "abc123",
  providerId: "provider-123",
  appId: "0x123456789",
  logLine: "Custom log entry",
  type: "custom.log",
});

loggerService.addLog(customLogEntry);
```

## Features

- Automatically batches logs and sends them periodically
- Sends logs immediately when batch size is reached
- Handles errors and retries failed log submissions
- Maintains persistent device ID for tracking
- Properly formats timestamps and log entries for Grafana

## Log Format

Each log entry includes:

- `logLine`: The message content
- `ts`: Timestamp in nanoseconds (Unix timestamp × 1,000,000)
- `type`: Category/module of the log
- `sessionId`: Current session identifier
- `providerId`: Provider identifier
- `appId`: Application identifier
