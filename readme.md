# Reclaim Protocol Browser Extension SDK — Integration Guide

Lightweight SDK to trigger Reclaim verification flows from **your website** or **your own extension UI (popup/panel)**.  
It wires content ↔ background, opens the provider tab, generates proofs via an **offscreen** document (WebAssembly), and emits completion events.

> Chrome **Manifest V3** compatible (Vite/CRA builds included).

---

## Table of Contents

1. [Install](#install)
2. [One-time Asset Setup](#one-time-asset-setup)
3. [Manifest (MV3) — Security & Permissions](#manifest-mv3--security--permissions)
4. [Manifest (MV3) — Required Entries](#manifest-mv3--required-entries)
5. [Load the SDK Content Bridge](#load-the-sdk-content-bridge)
6. [Common Step (Both Approaches): Initialize Background](#common-step-both-approaches-initialize-background)
7. [Approach 1: Use the SDK **inside your own extension** (popup/panel)](#approach-1-use-the-sdk-inside-your-own-extension-popuppanel)
8. [Approach 2: Basic setup in your extension + **start from a web app**](#approach-2-basic-setup-in-your-extension--start-from-a-web-app)
9. [Optional: Don’t expose keys client-side — generate a request config on your server](#optional-dont-expose-keys-client-side--generate-a-request-config-on-your-server)
10. [Vite/CRX specifics](#vitecrx-specifics)
11. [Troubleshooting](#troubleshooting)
12. [Checklist](#checklist)
13. [Types](#types)

---

## Install

```bash
npm i @reclaimprotocol/browser-extension-sdk
```

---

## One-time Asset Setup

Copies the SDK’s **prebuilt classic bundles** into your extension’s `public/` (so they are **not** re-bundled; Chrome content scripts must be classic, not ESM).

**package.json**

```json
{
  "scripts": {
    "reclaim-extension-setup": "node node_modules/@reclaimprotocol/browser-extension-sdk/build/scripts/install-assets.js --public-dir=public"
  }
}
```

**Run**

```bash
npm run reclaim-extension-setup
```

This ensures the following exist in your final build (no hashing, no ESM):

- `reclaim-browser-extension-sdk/content/content.bundle.js`
- `reclaim-browser-extension-sdk/offscreen/offscreen.html`
- `reclaim-browser-extension-sdk/offscreen/offscreen.bundle.js`
- `reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js`
- `reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js`
- `reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.(css|html)`

---

## Manifest (MV3) — Security & Permissions

Add **before** other entries:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
  },
  "host_permissions": ["<all_urls>"],
  "permissions": ["offscreen", "cookies"]
}
```

If you use **dynamic** content script registration (recommended for Vite/CRA), add `"scripting"`:

```json
{
  "permissions": ["offscreen", "cookies", "scripting"]
}
```

**Why these:**

- **CSP** enables WebAssembly for proof generation.
- **host_permissions** lets the SDK interact with provider sites.
- **offscreen** is required for background proof generation.
- **cookies** gives access to provider auth cookies.
- **scripting** is required for **dynamic** content script registration.

---

## Manifest (MV3) — Required Entries

### Web-accessible resources

```json
{
  "web_accessible_resources": [
    {
      "resources": [
        "reclaim-browser-extension-sdk/offscreen/offscreen.html",
        "reclaim-browser-extension-sdk/offscreen/offscreen.bundle.js",
        "reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js",
        "reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.html"
      ],
      "matches": ["<all_urls>"]
    }
  ]
}
```

**What they’re for**

- `offscreen.*`: proof generation + WebAssembly
- `interceptor/*`: network interception for provider auth
- `content/components/*`: built-in verification popup UI

---

## Load the SDK Content Bridge

Choose **one**: **static** (manifest) or **dynamic** (service worker).

### Static (manifest)

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

### Dynamic (service worker)

```ts
// background (service_worker)
chrome.runtime.onInstalled.addListener(() => {
  chrome.scripting.registerContentScripts(
    [
      {
        id: "reclaim-sdk",
        matches: ["<all_urls>"],
        js: ["reclaim-browser-extension-sdk/content/content.bundle.js"],
        runAt: "document_start",
        world: "ISOLATED",
      },
    ],
    () => void chrome.runtime.lastError,
  );
});

chrome.scripting.getRegisteredContentScripts((scripts) => {
  if (!scripts?.find((s) => s.id === "reclaim-sdk")) {
    chrome.scripting.registerContentScripts(
      [
        {
          id: "reclaim-sdk",
          matches: ["<all_urls>"],
          js: ["reclaim-browser-extension-sdk/content/content.bundle.js"],
          runAt: "document_start",
          world: "ISOLATED",
        },
      ],
      () => void chrome.runtime.lastError,
    );
  }
});
```

> Dynamic registration requires `"scripting"` permission.

---

## Common step (both approaches): Initialize Background

```js
// background entry (service_worker)
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

reclaimExtensionSDK.initializeBackground(); // idempotent
```

---

## Approach 1: Use the SDK **inside your own extension** (popup/panel)

**Minimal popup markup**

```html
<!-- popup.html -->
<div>
  <input id="appId" placeholder="Application ID" />
  <input id="appSecret" placeholder="Application Secret" />
  <input id="providerId" placeholder="Provider ID" />
  <button id="start">Start Verification</button>
  <pre id="out"></pre>

  <script src="popup.js" type="module"></script>
</div>
```

```js
// popup.js
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

document.getElementById("start").onclick = async () => {
  const appId = document.getElementById("appId").value.trim();
  const appSecret = document.getElementById("appSecret").value.trim();
  const providerId = document.getElementById("providerId").value.trim();

  const out = document.getElementById("out");
  out.textContent = "";

  try {
    const req = await reclaimExtensionSDK.init(appId, appSecret, providerId);

    request.on("started", ({ sessionId }) => console.log("started", sessionId));
    req.on("completed", (p) => (out.textContent = JSON.stringify(p, null, 2)));
    req.on("error", (e) => (out.textContent = `Error: ${e?.message || e}`));
  } catch (e) {
    out.textContent = `Error: ${e?.message || String(e)}`;
  }
};
```

---

## Approach 2: Basic setup in your extension + **start from a web app**

When you trigger from a webpage, **pass your Extension ID**.

```tsx
// Example React component (Vite)
import React, { useState } from "react";
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

const APP_ID = import.meta.env.VITE_RECLAIM_APP_ID;
const APP_SECRET = import.meta.env.VITE_RECLAIM_APP_SECRET;
const EXTENSION_ID = import.meta.env.VITE_RECLAIM_EXTENSION_ID;

export default function ReclaimButton({ providerId }: { providerId: string }) {
  const [loading, setLoading] = useState(false);
  const [proofs, setProofs] = useState(null);
  const [error, setError] = useState("");
  const [statusUrl, setStatusUrl] = useState("");
  const [req, setReq] = useState(null);

  const start = async () => {
    try {
      setLoading(true);
      setError("");
      setProofs(null);

      // Optional - You can also check if the extension is installed before starting:

      // const installed = await reclaimExtensionSDK.isExtensionInstalled({
      //   extensionID: EXTENSION_ID,
      // });

      // if (!installed) {
      //   alert("Please install the extension first.");
      //   return;
      // }

      const request = await reclaimExtensionSDK.init(APP_ID, APP_SECRET, providerId, {
        extensionID: EXTENSION_ID,
      });

      setReq(request);
      setStatusUrl(request.getStatusUrl());

      request.on("completed", (p) => {
        setProofs(p);
        setLoading(false);
      });

      request.on("error", (e) => {
        setError(e?.message || String(e));
        setLoading(false);
      });

      const p = await request.startVerification();
      setProofs(p);
    } catch (e) {
      setError(e?.message || String(e));
      setLoading(false);
    }
  };

  return (
    <div>
      <button onClick={start} disabled={loading}>
        {loading ? "Starting…" : "Start Verification"}
      </button>

      {statusUrl && (
        <p>
          Track status:{" "}
          <a href={statusUrl} target="_blank">
            status
          </a>
        </p>
      )}
      {error && <pre style={{ color: "crimson" }}>{error}</pre>}
      {proofs && <pre>{JSON.stringify(proofs, null, 2)}</pre>}
    </div>
  );
}
```

> **Important:** From a **web page**, the SDK cannot call `chrome.runtime.sendMessage` unless you provide `extensionID`.

---

## Optional: Don’t expose keys client-side — generate a request config on your server

Use **`@reclaimprotocol/js-sdk`** to generate a signed request config on the server.

**Server (Node/Express)**

```js
const express = require("express");
const { ReclaimProofRequest } = require("@reclaimprotocol/js-sdk");

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.text({ type: "*/*", limit: "50mb" }));

const BASE_URL = "https://your-domain.com";

app.get("/generate-config", async (_req, res) => {
  const APP_ID = "YOUR_APPLICATION_ID";
  const APP_SECRET = "YOUR_APPLICATION_SECRET";
  const PROVIDER_ID = "YOUR_PROVIDER_ID";

  try {
    const reclaimProofRequest = await ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID);
    reclaimProofRequest.setAppCallbackUrl(`${BASE_URL}/receive-proofs`);
    const reclaimProofRequestConfig = reclaimProofRequest.toJsonString();
    res.json({ reclaimProofRequestConfig });
  } catch (error) {
    res.status(500).json({ error: "Failed to generate request config" });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
```

**Client (web or popup)**

```ts
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

const EXTENSION_ID = "<your_extension_id>";

async function startFromServerConfig() {
  const r = await fetch("/generate-config").then((x) => x.json());
  const { reclaimProofRequestConfig } = r;

  const request = await reclaimExtensionSDK.fromJsonString(reclaimProofRequestConfig, {
    extensionID: EXTENSION_ID,
  });

  request.on("started", ({ sessionId }) => console.log("started", sessionId));
  request.on("completed", (p) => console.log("completed", p));
  request.on("error", console.error);
}
```

Docs: https://docs.reclaimprotocol.org/web/backend/usage

---

## Vite/CRX specifics

- Ensure SDK assets are copied **1:1** to your `dist` without hashing.
- Always load `content.bundle.js` (classic), not an ESM bundle.
- Use `vite-plugin-static-copy` if needed.

```ts
import { viteStaticCopy } from "vite-plugin-static-copy";

viteStaticCopy({
  targets: [
    {
      src: "node_modules/@reclaimprotocol/browser-extension-sdk/build/**/*",
      dest: "reclaim-browser-extension-sdk",
    },
  ],
});
```

---

## Troubleshooting

- **“Unexpected token 'export'”** → Load classic `content.bundle.js` instead of an ESM file.
- **“chrome.runtime.sendMessage called from a web page must specify Extension ID”** → Pass `{ extensionID }`.
- **Provider tab doesn’t open** → Check assets, permissions, background init, and content script registration.

---

## Checklist

- [x] Ran `npm run reclaim-extension-setup`
- [x] Manifest includes CSP, host_permissions, and permissions (`offscreen`, `cookies`, `scripting` if dynamic)
- [x] Added `web_accessible_resources`
- [x] Content bundle loaded (static/dynamic)
- [x] Background initialized once
- [x] Passed `extensionID` from web usage (if applicable)

---

## Types

```ts
import type { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";
```
