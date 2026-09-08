# Logging

The SDK has one logging pipeline. The background `loggingHub` enriches and
batches logs before sending them to Reclaim's diagnostic endpoint. Content and
offscreen contexts use `createRemoteLogger()` to forward entries to that hub.
Page-world interceptor scripts use the `RECLAIM_LOG` window message because
they cannot call `chrome.runtime`.

## Usage

```js
import { loggingHub } from "./LoggingHub.js";
import { EVENT_TYPES } from "./constants.js";

loggingHub.info("Provider data loaded", "background.provider", {
  eventType: EVENT_TYPES.FETCHED_PROVIDERS,
});
```

For content and offscreen modules:

```js
import { createRemoteLogger } from "./RemoteLogger.js";

const logger = createRemoteLogger("content");
logger.warn("Response match is pending", "content.filter");
```

Use a dotted category (`background.claim`, `content.filter`) and an
`EVENT_TYPES` value when the line maps to a lifecycle event. Pass structured
data as `options.payload`; never concatenate response bodies, credentials,
extracted values, or proofs into the message string.

## Levels and privacy

`INFO` is the default and redacts payload values. `FINE` is opt-in and sends
raw diagnostic payloads to the endpoint as well as the console when enabled.
`SEVERE` and `WARNING` remain visible at the default threshold. `debug()` is a
backward-compatible alias for `FINE`; `fine()` is the canonical spelling.

Configure the level with `reclaimExtensionSDK.setLogConfig()` or the `logConfig`
option to `init()`. Keep `consoleEnabled` separate from `logLevel`: it only
controls local mirroring and does not change remote collection.

```js
await reclaimExtensionSDK.setLogConfig({
  logLevel: "INFO",
  consoleEnabled: true,
});
```

The logging hub persists its queue in `chrome.storage.session` and flushes on
batch size, terminal cleanup, and a periodic schedule. Keep cleanup paths
awaiting `clearSessionContext()` so terminal errors are not lost when an MV3
service worker stops.
