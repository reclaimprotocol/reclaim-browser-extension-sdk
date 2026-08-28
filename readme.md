# Reclaim Protocol Browser Extension SDK

Trigger Reclaim zero-knowledge proof verification from your browser extension or website.

> Chrome **Manifest V3**. MV2/Firefox bundles are also included.

## Install

```bash
npm i @reclaimprotocol/browser-extension-sdk
```

## 1. Copy the SDK assets

The SDK ships prebuilt bundles that must be copied into your extension's `public/` folder — they cannot be re-bundled.

Add the script to your `package.json`:

```json
{
  "scripts": {
    "reclaim-extension-setup": "node node_modules/@reclaimprotocol/browser-extension-sdk/build/scripts/install-assets.js --public-dir=public"
  }
}
```

Then run it (after every `npm install`):

```bash
npm run reclaim-extension-setup
```

This also downloads the ZK circuits (~280 MB, cached after the first run).

## 2. Update your manifest

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
  },
  "host_permissions": ["<all_urls>"],
  "permissions": [
    "offscreen",
    "cookies",
    "scripting",
    "storage",
    "declarativeNetRequest",
    "alarms"
  ],
  "content_scripts": [
    {
      "js": ["reclaim-browser-extension-sdk/content/content.bundle.js"],
      "run_at": "document_start",
      "matches": ["<all_urls>"]
    }
  ],
  "web_accessible_resources": [
    {
      "resources": [
        "reclaim-browser-extension-sdk/offscreen/offscreen.html",
        "reclaim-browser-extension-sdk/offscreen/offscreen.bundle.js",
        "reclaim-browser-extension-sdk/offscreen/load-s2circuits.js",
        "reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js",
        "reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.html",
        "browser-rpc/resources/stwo/*",
        "browser-rpc/resources/snarkjs/*"
      ],
      "matches": ["<all_urls>"]
    }
  ]
}
```

All of it is required. `wasm-unsafe-eval` runs the ZK prover, `offscreen` hosts it, `cookies` reads the provider's auth session, and `scripting` + `declarativeNetRequest` let provider scripts run on strict-CSP sites (scoped to one hostname, only while a verification is in progress, removed when it ends).

## 3. Initialize the background

```js
// service worker (background.js)
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

reclaimExtensionSDK.initializeBackground();
```

## 4. Start a verification

From your extension's popup or side panel:

```js
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, PROVIDER_ID);

request.on("completed", (proofs) => console.log(proofs));
request.on("error", (err) => console.error(err));

await request.startVerification();
```

From a web page — same thing, but pass your extension ID:

```js
const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, PROVIDER_ID, {
  extensionID: "your-chrome-extension-id",
});
```

That's it. The SDK opens the provider's site, waits for the user to sign in, builds the claim, and resolves `completed` with the proofs.

## Keeping your app secret off the client

Generate a signed config on your server with `@reclaimprotocol/js-sdk`:

```js
// server
const { ReclaimProofRequest } = require("@reclaimprotocol/js-sdk");

const proofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
proofRequest.setAppCallbackUrl("https://your-domain.com/receive-proofs");
const config = proofRequest.toJsonString();
```

```js
// client
const request = await reclaimExtensionSDK.fromJsonString(config, {
  extensionID: "your-chrome-extension-id",
});
```

## Troubleshooting

| Issue                                | Fix                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Unexpected token 'export'`          | Load `content.bundle.js` from the manifest, not an ESM file                                              |
| `must specify Extension ID`          | Pass `{ extensionID }` when starting from a web page                                                     |
| Provider tab never opens             | Check `initializeBackground()` ran and the content script is registered                                  |
| Proof generation fails               | Re-run `npm run reclaim-extension-setup`; check `web_accessible_resources` includes both circuit folders |
| Assets missing after a fresh install | Run `npm run reclaim-extension-setup` again — CI often prunes `node_modules`                             |

## Examples

- [`examples/basic-extension`](examples/basic-extension) — extension popup
- [`examples/web-app`](examples/web-app) — web page (needs `extensionID`)
