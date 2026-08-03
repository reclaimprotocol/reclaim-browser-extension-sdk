# Reclaim Protocol Browser Extension SDK

SDK to trigger Reclaim zero-knowledge proof verification flows from your website or browser extension.

> Chrome **Manifest V3** compatible.

---

## Quick Start

### 1. Install

```bash
npm i @reclaimprotocol/browser-extension-sdk
```

### 2. Copy SDK Assets

The SDK ships prebuilt bundles that must be copied into your extension's `public/` folder (they cannot be re-bundled).

Add to your `package.json`:

```json
{
  "scripts": {
    "reclaim-extension-setup": "node node_modules/@reclaimprotocol/browser-extension-sdk/build/scripts/install-assets.js --public-dir=public"
  }
}
```

Then run:

```bash
npm run reclaim-extension-setup
```

### 3. Manifest Setup

Add these to your `manifest.json`:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
  },
  "host_permissions": ["<all_urls>"],
  "permissions": ["offscreen", "cookies", "scripting", "storage", "declarativeNetRequest"],
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

**Why these permissions:**

| Permission              | Reason                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| `wasm-unsafe-eval`      | WebAssembly for ZK proof generation                                        |
| `offscreen`             | Background proof generation via offscreen document                         |
| `cookies`               | Access provider auth cookies                                               |
| `scripting`             | Content script registration and custom injection                           |
| `storage`               | SDK config and session state                                               |
| `declarativeNetRequest` | Temporary CSP header modification for custom injection on strict-CSP sites |

### 4. Initialize Background

```js
// In your service worker (background.js)
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

reclaimExtensionSDK.initializeBackground();
```

### 5. Start Verification

**From extension popup/panel:**

```js
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, PROVIDER_ID);

request.on("completed", (proofs) => console.log(proofs));
request.on("error", (err) => console.error(err));
```

**From a web page** (pass your extension ID):

```js
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, PROVIDER_ID, {
  extensionID: "your-chrome-extension-id",
});

request.on("completed", (proofs) => console.log(proofs));
request.on("error", (err) => console.error(err));

await request.startVerification();
```

---

## Server-Side Config (Optional)

To avoid exposing keys client-side, generate a signed config on your server using `@reclaimprotocol/js-sdk`:

```js
// Server
const { ReclaimProofRequest } = require("@reclaimprotocol/js-sdk");

const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
reclaimProofRequest.setAppCallbackUrl("https://your-domain.com/receive-proofs");
const config = reclaimProofRequest.toJsonString();
```

```js
// Client
const request = await reclaimExtensionSDK.fromJsonString(config, {
  extensionID: "your-chrome-extension-id",
});
```

---

## How Circuit Assets Are Fetched

The SDK relies on Zero-Knowledge circuit binaries (~280MB) provided by [`@reclaimprotocol/zk-symmetric-crypto`](https://www.npmjs.com/package/@reclaimprotocol/zk-symmetric-crypto), pulled in as a transitive dependency.

When you run `npm run reclaim-extension-setup`:

1. If `node_modules/@reclaimprotocol/zk-symmetric-crypto/resources/` is missing, the setup script invokes the upstream package's downloader to populate it (one-time; cached across re-runs).
2. That `resources/` folder is then copied into `<your-extension>/public/browser-rpc/resources/`, which is what the manifest's `web_accessible_resources` points at.

**CI / Docker tip:** Run `npm run reclaim-extension-setup` _after_ `npm install`. If your pipeline prunes `node_modules` between steps, the circuits will be re-downloaded the next time setup runs.

---

## Custom Injections & CSP

Some providers ship a small `customInjection` script that must run on the provider's page to extract data. On strict-CSP sites (e.g. LinkedIn), inline execution is blocked, so the SDK uses `chrome.scripting.executeScript` to inject into the MAIN world and temporarily strips the page's CSP header via a `chrome.declarativeNetRequest` **session rule**.

**This is safe:** the rule is scoped to a single provider hostname, only active for the duration of an in-progress verification, and auto-removed on session end, failure, or after a max lifetime. This is why the manifest needs `declarativeNetRequest` and `scripting` permissions.

---

## Troubleshooting

| Issue                               | Fix                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `Unexpected token 'export'`         | Load `content.bundle.js` (classic), not an ESM file                         |
| `must specify Extension ID`         | Pass `{ extensionID }` when calling from a web page                         |
| Provider tab doesn't open           | Check assets, permissions, background init, and content script registration |
| Proof generation fails with snarkjs | Ensure `browser-rpc/resources/snarkjs/*` is in `web_accessible_resources`   |

---

## Checklist

- [ ] Ran `npm run reclaim-extension-setup`
- [ ] Manifest has all required permissions and CSP
- [ ] Added `web_accessible_resources` (including stwo and snarkjs circuits)
- [ ] Content bundle loaded via manifest or dynamic registration
- [ ] Background initialized with `initializeBackground()`
- [ ] Passed `extensionID` when starting from a web page
