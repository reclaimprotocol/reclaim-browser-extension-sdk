# Content script

The content script is injected at `document_start` on matching pages. It
activates only for a provider tab that the background marks as managed. It
coordinates the page-world interceptor, request matching, the verification
popup, and messages to the background service worker.

## Files

- `content.js` is the entry point and owns request filtering and lifecycle
  messages.
- `components/reclaim-provider-verification-popup.js` renders the status UI.
- `components/reclaim-provider-verification-popup.html` and `.css` are popup
  assets copied by the SDK install script.

## Runtime flow

```text
page-world interceptor → content.js → background service worker
background status      → content.js → popup and page-world SDK
```

The page-world scripts cannot call `chrome.runtime`. They send diagnostic logs
through the `RECLAIM_LOG` window message, and `content.js` relays them with
their original context. The SDK page API uses the same window-message channel;
extension pages use `chrome.runtime` directly.

When the background sends `PROVIDER_DATA_READY`, the content script injects
the interceptor and injection scripts, starts polling captured requests, and
reports the furthest matching stage. A request can advance from URL to method,
body, response, and redaction as its response becomes available. Keep the
stage values from `network-filter.js` in sync with diagnostics and tests.

## Message actions

Use `MESSAGE_ACTIONS` and `RECLAIM_SDK_ACTIONS` from
`src/utils/constants/interfaces.js`; do not repeat string literals.

The main actions are:

- `CONTENT_SCRIPT_LOADED`, `CHECK_IF_MANAGED_TAB`, and `SHOULD_INITIALIZE`
  establish whether this page belongs to an active session.
- `REQUEST_PROVIDER_DATA`, `PROVIDER_DATA_READY`, and
  `INTERCEPTED_REQUEST_AND_RESPONSE` drive request capture.
- `FILTERED_REQUEST_FOUND` forwards a matching request to the background.
- `CLAIM_CREATION_*`, `PROOF_GENERATION_*`, `PROOF_SUBMITTED`, and
  `PROOF_SUBMISSION_FAILED` update the popup and page API.
- `RECLAIM_LOG` and `RECLAIM_LOG_CONFIG` carry page-world diagnostics and
  logging configuration.

The content script is rebuilt on every navigation. Do not rely on its in-memory
maps or counters to survive a provider transition; session-wide state belongs
in the background. Progress messages include the background-owned
`data.progress` value when available.
