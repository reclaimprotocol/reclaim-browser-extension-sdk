## @reclaimprotocol/browser-extension-sdk

A browser extension SDK that triggers Reclaim verification flows from a website or from your own extension UI (popup/options page). It orchestrates a content script ↔ background flow to generate ZK proofs and delivers completion events back to your app.

### What you get

- One SDK API that works in both contexts:
  - Web app: communicates via `window.postMessage` and content script.
  - Extension UI (popup/options): communicates via `chrome.runtime` directly to background.
- Clean event model with strict session routing (by `sessionId`).
- Optional callback submission to your server.
- Install/setup script to place assets and circuits into your extension.

---

## Installation

```bash
# In your extension project and in your website project
npm i @reclaimprotocol/browser-extension-sdk
```

---

## Extension integration

### 1) Copy SDK assets and circuits

Add this script to your extension `package.json`:

```json
{
  "scripts": {
    "reclaim:setup": "node node_modules/@reclaimprotocol/browser-extension-sdk/build/scripts/install-assets.js --public-dir=public",
    "build": "vite build"
  }
}
```

What it does:

- Downloads ZK circuits into `public/browser-rpc/resources`.
- Copies SDK assets under `public/reclaim-browser-extension-sdk`.

Ensure your `manifest.json` has web-accessible resources (add if missing):

```json
{
  "web_accessible_resources": [
    {
      "resources": [
        "reclaim-browser-extension-sdk/offscreen/offscreen.html",
        "reclaim-browser-extension-sdk/offscreen/offscreen.bundle.js"
      ],
      "matches": ["<all_urls>"]
    },
    { "resources": ["reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js"], "matches": ["<all_urls>"] },
    { "resources": ["reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js"], "matches": ["<all_urls>"] },
    {
      "resources": [
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.html"
      ],
      "matches": ["<all_urls>"]
    }
  ]
}
```

Add the SDK content bundle before your own content script:

```json
{
  "content_scripts": [
    {
      "js": ["reclaim-browser-extension-sdk/content/content.bundle.js", "yourContent.js"],
      "run_at": "document_start",
      "matches": ["<all_urls>"]
    }
  ]
}
```

### 2) Initialize background

Your extension service worker (background) must initialize the SDK once:

```js
// background entry (e.g., src/extensionBackground.js)
import { sdk } from "@reclaimprotocol/browser-extension-sdk";
sdk.runBackground(); // sync, idempotent
```

Notes:

- No dynamic import in service worker (MV3 disallows top-level import()).
- Do not call the request API from the service worker itself.

---

## Website integration (web flow)

Use the SDK directly in your web app. The extension content script will relay your request to background.

```js
import { sdk } from "@reclaimprotocol/browser-extension-sdk";

const req = await sdk.init(APP_ID, APP_SECRET, PROVIDER_ID, {
  // extensionID: '<your-extension-id>', // optional strict check
  // callbackUrl: 'https://your.server/receive-proofs', // optional
  // providerVersion: '',
  // acceptAiProviders: false
});

// Optional: set params/context
// req.setParams({ foo: 'bar' });
// req.addContext('0x0', 'sample context');

req.on("started", ({ sessionId }) => console.log("started", sessionId));
req.on("completed", (proofs) => console.log("completed", proofs));
req.on("error", (err) => console.error("error", err));

const proofs = await req.startVerification();
console.log("proofs via promise", proofs);

// Helpers
console.log("status url:", req.getStatusUrl());
console.log("sdk version:", sdk.version());

// Optional
await req.cancel(); // cancels an in-progress session
```

Check extension presence:

```js
const installed = await sdk.checkExtensionInstalled(); // non-strict
// or strict:
const installed = await sdk.checkExtensionInstalled({ extensionID: "<your-extension-id>" });
```

---

## Extension UI (popup/options) integration

You can use the same API from your popup/options page (any `chrome-extension://` page). The SDK auto-detects it and communicates directly with background.

```js
import { sdk } from "@reclaimprotocol/browser-extension-sdk";

async function startFromPopup(providerId) {
  const req = await sdk.init(APP_ID, APP_SECRET, providerId);
  req.on("completed", (proofs) => console.log("popup completed", proofs));
  req.on("error", (e) => console.error("popup error", e));
  await req.startVerification();
}
```

Requirements:

- Background must be initialized (see Extension integration step).
- Do not use this API from a content script. If a content script must start a session, send a `chrome.runtime.sendMessage` to background (`START_VERIFICATION`) with a prepared template.

---

## API reference

### sdk.init(applicationId: string, appSecret: string, providerId: string, options?)

Returns a per-request object.

Options:

- extensionID?: string — if provided, content will only accept messages from this extension ID; if omitted, non-strict.
- callbackUrl?: string — optional; if set, background POSTs proofs to this URL and you still receive `completed`.
- providerVersion?: string
- acceptAiProviders?: boolean

### request.startVerification(): Promise<Proof[] | Proof>

Triggers the flow and resolves with proofs. Also emits events.

### request.on(event, cb) / request.off(event, cb)

Events: `started`, `completed`, `error`, `progress` (progress hooks are stubs for now).

### request.setAppCallbackUrl(url: string, jsonProofResponse?: boolean)

Sets a callback URL; background submits and also forwards proofs to the page.

### request.setParams(params: Record<string, string>)

Merges parameters used by provider matching.

### request.addContext(address: string, message: string)

Sets the proof context.

### request.getStatusUrl(): string

Returns the backend status URL for the current session.

### request.cancel(): Promise<boolean>

Cancels an in-progress verification. Emits `error` with “Cancelled by user”.

### sdk.checkExtensionInstalled({ extensionID?, timeout? }?)

Returns boolean. If no `extensionID` provided, returns true if any Reclaim extension responds.

### sdk.version(): string

Returns SDK version string.

---

## Flows overview

- Web flow
  - Website → SDK → window.postMessage → content → background → provider tab → proofs generated → background → content → website (window message).
  - Background always attaches `sessionId`; content forwards with `messageId=sessionId` so SDK filters strictly.

- Extension UI flow (popup/options)
  - Popup → SDK → chrome.runtime.sendMessage → background → provider tab → proofs generated → background → chrome.runtime.sendMessage (broadcast) → popup SDK receives events.

- Optional callbackUrl
  - If provided, background POSTs URL-encoded JSON proofs to your server.
  - Regardless, `completed` event delivers proofs locally.

- Concurrency and sessions
  - Background is single-session at a time; it guards with `ctx.activeSessionId`.
  - SDK serializes `startVerification()` calls with an internal queue.
  - Future: refactor background to multi-session (map keyed by sessionId) to allow parallel runs.

---

## Manifest notes

- Ensure you inject the SDK content bundle before your own content script.
- Include `offscreen` and `cookies` permissions if you use the SDK-provided flows using offscreen.
- Ensure the SDK assets listed above are web-accessible.

---

## Security notes

- Strict extension check: pass `extensionID` from your website if you want to ensure you’re talking to your own extension build. The content script compares it against `chrome.runtime.id`.
- Consider signing on your backend to avoid shipping `APP_SECRET` in the browser.

---

## Troubleshooting

- No `started` event in web app
  - Likely extension ID mismatch. Use non-strict check (omit `extensionID`) or pass the correct one.

- No `completed` event
  - Ensure background includes `sessionId` in messages (done) and content forwards with `messageId`.

- MV3 service worker error about dynamic imports
  - Don’t use dynamic import in background. Use `sdk.runBackground()` with static import as shown.

- Circuits re-downloaded twice
  - Avoid running `prebuild` twice (don’t chain `npm run prebuild && vite build` if npm runs `prebuild` automatically).

---

## Example React component (website)

```jsx
import React, { useMemo, useState } from "react";
import { sdk } from "@reclaimprotocol/browser-extension-sdk";

export default function ReclaimDemo() {
  const [installed, setInstalled] = useState(null);
  const [loading, setLoading] = useState(false);
  const [proofs, setProofs] = useState(null);
  const [error, setError] = useState("");
  const providerId = "<PROVIDER_ID>";

  async function checkInstalled() {
    const ok = await sdk.checkExtensionInstalled(); // or { extensionID: '<id>' }
    setInstalled(ok);
  }

  async function start() {
    try {
      setLoading(true);
      setError("");
      setProofs(null);

      const req = await sdk.init("<APP_ID>", "<APP_SECRET>", providerId);
      req.on("completed", (p) => {
        setProofs(p);
        setLoading(false);
      });
      req.on("error", (e) => {
        setError(e?.message || String(e));
        setLoading(false);
      });

      const p = await req.startVerification();
      setProofs(p);
    } catch (e) {
      setError(e?.message || String(e));
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={checkInstalled}>Check Extension</button>
      <button onClick={start} disabled={loading || installed === false}>
        {loading ? "Starting…" : "Start"}
      </button>
      {error && <div>{error}</div>}
      {proofs && <pre>{JSON.stringify(proofs, null, 2)}</pre>}
    </div>
  );
}
```

---

## License

MIT
