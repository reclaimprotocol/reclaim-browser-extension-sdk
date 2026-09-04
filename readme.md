# Reclaim Protocol Browser Extension SDK

Trigger Reclaim zero-knowledge proof verification from your browser extension or website.

> Chrome **Manifest V3**. MV2/Firefox bundles are also included.

> **Builder mode:** URLs whose query contains exactly `api=2` use Builder's
> direct Verification API. URLs without that value, or with another API
> version, keep the legacy flow.

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

### Builder mode (`api=2`)

Create a Builder session with `verificationClientUrl` set to the registered
extension URL. The session response includes `verificationUrl` and
`verificationClientId`. The client ID is a public routing identifier, not an
authentication credential. Pass both values to the extension:

```js
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

// `session` is the response from your session-creation call:
// { verificationUrl: string, verificationClientId: string }
async function startBuilderVerification(session) {
  const request = reclaimExtensionSDK.fromVerificationUrl(session.verificationUrl, {
    verificationClientId: session.verificationClientId,
    extensionID: "your-chrome-extension-id", // omit inside the extension itself
  });

  request.on("completed", (proofs) => console.log(proofs));
  request.on("error", (err) => console.error(err));

  await request.startVerification();
}
```

Use `initBuilder(verificationUrl, options)` when an asynchronous entry point is
more convenient. Both entry points require a registered
`verificationClientId`, reject URLs without an exact `api=2` query, and require
a non-empty `sessionId`. They accept an optional HTTPS `backendUrl` and bounded
`claimantDetails`. If `claimantClientId` is omitted, the extension generates a
UUID and persists it in extension storage. The extension automatically adds
viewport and display dimensions, orientation, and all User-Agent Client Hints
the active tab permits it to read. A browser can omit or reduce high-entropy
hints; this never blocks verification.

Builder mode uses the generated client for Builder's direct Verification API
contract in `project-new-tools/builder/packages/app/openapi.yaml`. The deployed
client routes are `/verifications/sessions/{sessionId}/bootstrap`, `/claimant`,
`/events`, `/attestor-auth`, and `/results`. Every request includes
`x-reclaim-vc-id`; Builder validates the session and Verification Client
binding before it returns data. The header identifies the client for routing;
it does not authenticate the caller.

The Builder API URL must use HTTPS and can't be
`https://api.reclaimprotocol.org`. The legacy API remains available only to
URLs that don't select `api=2`.

Don't edit `src/generated/builder-bridge` or
`src/generated/builder-bridge.gen.js`. The output directory keeps its historical
name; it contains the Builder API client and no backend bridge. The generator prefers the adjacent
Builder app checkout at `../project-new-tools/builder/packages/app/openapi.yaml`
and falls back to the deployed Builder contract.
Regenerate both after an API change:

```sh
npm run generate:builder-bridge
```

To test an unpublished Builder contract, set `BUILDER_OPENAPI`:

```sh
BUILDER_OPENAPI=/absolute/path/to/openapi.yaml \
  npm run generate:builder-bridge
```

The `generate:builder-bridge` script name is retained for compatibility; it
generates only the Builder client. Regenerate the checked-in output after the
Builder OpenAPI contract changes instead of editing generated files.

Commit the regenerated files with the consuming code. Review the OpenAPI
change instead of editing generated paths, models, or enums.

The extension sends no legacy app secret or provider signature to the
`attestor-auth` route. The route returns session-bound attestor authorization.
The extension resolves the bootstrap recipes, passes the session context and
TEE nonce/application data into each legacy claim, obtains session-bound
attestor authentication before each provider, and runs providers sequentially.
Builder recipes resolve scalar session context as `{{context.key}}`, then
`{{context_key}}`, then `{{key}}`; a lower-priority alias is used only when a
higher-priority spelling isn't present. Explicit parameters win. This applies
to URLs, headers, bodies, response matches and redactions, custom injection,
and interceptor-created claims.
Builder-owned `reclaimSessionId` and `attestationNonce` remain context-only.
Builder mode skips legacy
offscreen session-status calls and uses Builder for session lifecycle
updates. It emits applicable canonical browser, page, interceptor, request,
claim, provider, proof, result-submission, and cancellation events, including
`verification_result_submitting` and `verification_result_submission_failed`
when applicable. It does not send terminal success or error as a separate
best-effort event: the `results` request makes Builder record the matching
terminal event strongly before signing and storing result deliveries. It does
not claim consent, authentication, or user-input events it cannot observe. It
submits the exact raw legacy `Proof` objects inside the Builder result envelope.
Builder signs the outer result and encrypts callback deliveries when configured;
signing and encryption keys never enter the extension. The extension does not
validate `allowedJsRequests` or verify proofs client-side; consumers verify
Builder deliveries with `verifyResultFull` and `verifyProof`.
When an optional response-match expectation isn't met, the extension omits only
that match from the attestor request. It preserves Builder's independent
`responseRedactions` list unchanged.
Builder owns event storage, callback delivery, retries, and encryption. Treat
`claimantDetails` as diagnostics only; do not put cookies, credentials, URLs,
form values, provider responses, or proof contents in it.
If result submission fails, the extension reports
`verification_result_submission_failed` when it can and does not signal a
completed Builder result.

The extension doesn't yet render Builder's organization consent screen. If a
session contains consent content, the extension submits a terminal error and
stops before opening the provider. This fail-closed behavior prevents the
extension from silently treating consent as accepted. Use Portal or a mobile
client for consent-enabled sessions until the extension consent UI is added.

When the URL has no exact `api=2` query, or has an unknown API version, keep
using `init`, `fromJsonString`, and the existing direct callback flow. Legacy
`oprf-raw` behavior is unchanged.

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
const request = reclaimExtensionSDK.fromJsonString(config, {
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
