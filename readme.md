# Reclaim Protocol Browser Extension SDK Integration Guide

This guide will walk you through integrating the Reclaim Protocol Browser Extension SDK into your own browser extension or web application.  
It covers installation, manifest configuration, background initialization, content script setup, and how to trigger verification flows from a popup, panel, or webpage.  
Follow this step-by-step guide to ensure smooth integration with Chrome Manifest V3 extensions (including Vite/CRA builds).

A lightweight SDK to trigger Reclaim verification flows from your website or your own extension UI (popup/panel). It wires content ↔ background, opens the provider tab, generates proofs via an offscreen document, and emits completion events.

## Install

```bash
npm i @reclaimprotocol/browser-extension-sdk
```

## One-time asset setup

Copies the SDK’s prebuilt classic bundles into your extension’s static folder so they are not re-bundled (Chrome requires classic scripts for content).

Add to your extension app’s package.json:

```json
{
  "scripts": {
    "reclaim:setup": "node node_modules/@reclaimprotocol/browser-extension-sdk/build/scripts/install-assets.js --public-dir=public"
  }
}
```

Run:

```bash
npm run reclaim:setup
```

What this does:

- Copies node_modules/@reclaimprotocol/browser-extension-sdk/build/** → public/reclaim-browser-extension-sdk/**
- Ensures the following exist in your final build (no hashing, no ESM):
  - reclaim-browser-extension-sdk/content/content.bundle.js
  - reclaim-browser-extension-sdk/offscreen/offscreen.html
  - reclaim-browser-extension-sdk/offscreen/offscreen.bundle.js
  - reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js
  - reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js
  - reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.(css|html)

---

## Manifest (MV3) — security & permissions

Add these before other entries:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
  },
  "host_permissions": ["<all_urls>"],
  "permissions": ["offscreen", "cookies"]
}
```

If you use dynamic content script registration (recommended for Vite/CRA), also add:

```json
{
  "permissions": ["offscreen", "cookies", "scripting"]
}
```

---

## Manifest (MV3) — required entries

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

### Load the SDK content bridge (choose ONE)

Static (manifest):

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

Dynamic (service worker):

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

(Remember: Dynamic registration requires "scripting" permission.)

---

## Initialize background (once)

```js
// background entry (service_worker)
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

reclaimExtensionSDK.initializeBackground(); // idempotent
```

---

## Create a proof request (panel/popup/web)

- When calling from a web page, pass your extensionID.
- When calling from extension UI (popup/panel), omit extensionID (the SDK detects extension context).

Example: panel/popup.tsx

```tsx
// @ts-nocheck
import React, { useState } from "react";
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

export default function Panel() {
  const [appId, setAppId] = useState("YOUR_APPLICATION_ID_HERE");
  const [appSecret, setAppSecret] = useState("YOUR_APPLICATION_SECRET_HERE");
  const [providerId, setProviderId] = useState("YOUR_PROVIDER_ID_HERE");

  const [proofs, setProofs] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const startVerification = async () => {
    setError("");
    setIsLoading(true);
    setProofs(null);

    try {
      const request = await reclaimExtensionSDK.createProofRequest(appId, appSecret, providerId, {
        // extensionID: "abcdefghijklmnopabcdefghijklmnop", // only if calling from web page
      });

      request.on("started", ({ sessionId }) => {
        console.log("Verification started", sessionId);
      });

      request.on("progress", (step) => {
        console.log("Progress", step);
      });

      request.on("completed", (p) => {
        console.log("Proofs (event)", p);
        setProofs(p);
        setIsLoading(false);
      });

      request.on("error", (err) => {
        console.error("Verification error", err);
        setError(err?.message || String(err));
        setIsLoading(false);
      });
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-4 bg-white h-screen">
      <h1 className="text-2xl font-bold text-black">T-Rext for zkTLS demo...</h1>

      <label className="w-full text-sm text-black flex flex-col gap-1">
        <span>App ID</span>
        <input
          id="appId"
          className="border border-gray-300 p-2 rounded-md text-black w-full"
          type="text"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
        />
      </label>

      <label className="w-full text-sm text-black flex flex-col gap-1">
        <span>App Secret</span>
        <input
          id="appSecret"
          className="border border-gray-300 p-2 rounded-md text-black w-full"
          type="text"
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
        />
      </label>

      <label className="w-full text-sm text-black flex flex-col gap-1">
        <span>Provider ID</span>
        <input
          id="providerId"
          className="border border-gray-300 p-2 rounded-md text-black w-full"
          type="text"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        />
      </label>

      <button
        disabled={isLoading}
        className="bg-blue-500 text-white p-2 rounded-md cursor-pointer"
        onClick={startVerification}
      >
        {isLoading ? "Generating proofs..." : "Start Verification"}
      </button>

      {!!error && <div className="text-red-600 text-sm w-full break-words">Error: {error}</div>}

      {!!proofs && (
        <pre className="w-full max-h-64 overflow-auto bg-gray-100 text-black p-2 rounded-md text-xs">
          {JSON.stringify(proofs, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

---

## Vite/CRX (trex example) specifics

- Ensure SDK assets are copied 1:1 to your dist without hashing:
  - Use the provided script npm run reclaim:setup, or
  - Use vite-plugin-static-copy:

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

- Register the SDK content script dynamically.
- Initialize background once with reclaimExtensionSDK.initializeBackground().

Why this matters for Vite + CRA:
Some setups output ESM content bundles by default. Chrome expects classic scripts. Loading the prebuilt classic content.bundle.js avoids “Unexpected token 'export'”.

---

## Troubleshooting

- “Unexpected token 'export'”  
  You are loading a Vite-bundled ESM file. Load reclaim-browser-extension-sdk/content/content.bundle.js directly.

- “chrome.runtime.sendMessage called from a web page must specify Extension ID”  
  Pass options.extensionID to createProofRequest when calling from a web page.

- Provider tab doesn’t open / flow doesn’t progress  
  Check assets are present, manifest has resources, background initialized, content script registered, and “scripting” permission added if dynamic.

---

## Checklist

- Ran npm run reclaim:setup
- Manifest includes:
  - content_security_policy.extension_pages
  - host_permissions: ["<all_urls>"]
  - permissions: ["offscreen", "cookies"] (+ "scripting" if dynamic)
  - web_accessible_resources
- Content bundle loaded (static or dynamic)
- Background calls initializeBackground()
- Web usage passes extensionID to createProofRequest

---

Notes:

- Provider tab closes automatically on success/failure.
- Do not re-bundle SDK assets. Load from public/reclaim-browser-extension-sdk/\*\*
- Types included:

```ts
import type { ReclaimExtensionProofRequest } from "@reclaimprotocol/browser-extension-sdk";
```

```

```
