# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@reclaimprotocol/browser-extension-sdk` — lets a website or a browser extension trigger a Reclaim
zero-knowledge-proof verification flow. The SDK opens the provider's site in a managed tab, intercepts
the page's network traffic, builds a claim from a matching request, generates a ZK proof in an offscreen
document (WASM), and submits/emits the proof.

This is a **library**, not a shippable extension. It publishes prebuilt bundles that a consumer
extension copies into its own `public/` folder — consumers cannot re-bundle them. Chrome MV3 primary,
MV2/Firefox variants also emitted.

## Contents

- [Commands](#commands)
- [Architecture](#architecture)
- [The claim object must satisfy the attestor's schema exactly](#the-claim-object-must-satisfy-the-attestors-schema-exactly)
- [Provider values wider than this SDK supports](#provider-values-wider-than-this-sdk-supports)
- [Messaging](#messaging)
- [Provider-facing page API](#provider-facing-page-api)
- [CSP stripping](#csp-stripping)
- [Offscreen document](#offscreen-document)
- [Build output and bundle-format constraints](#build-output-and-bundle-format-constraints)
- [Logging](#logging)
- [`reclaim-api-client`](#reclaim-api-client)
- [Documentation map](#documentation-map)

## Commands

```bash
npm run build     # prettier --write . (prebuild), then webpack over all 3 configs → build/ + zip/
npm test          # node:test over src/**/*.test.js
npm run format    # prettier --write .
```

- [example-provider.test.js](src/utils/claim-creator/example-provider.test.js) is the closest thing to
  an end-to-end check: it takes the three `requestData` entries of the **published** `example` provider
  and walks a real request/response pair through `describeRequestMatch` → `extractParamsFromResponse`,
  asserting the parameter values a real session actually produced (2b46b57c39). It covers all three of
  that provider's redaction styles (`xPath+regex`, `jsonPath+regex`, `jsonPath+regex+hash`). It does
  **not** cover proof generation — that needs WASM, the ZK circuits and a live attestor socket. Update
  its fixtures if the provider is republished.
- Tests run on Node's built-in runner — no Jest. Source files are ESM `.js` in a package with no
  `"type": "module"` (webpack.config.js is CJS, so it can't be added), so Node falls back to module-syntax
  detection; `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` in the `test` script silences the resulting
  noise. **Relative imports in `src/utils/claim-creator/` need explicit `.js` extensions** — webpack
  resolves extensionless paths, Node's ESM loader does not.
- The test glob is quoted so Node expands it, not the shell. Don't pass a bare directory to `node --test`:
  it runs _every_ file in it, including non-tests like `src/utils/polyfill-test.js`.
- **`reclaim-extension-setup` is not a script in this repo.** It's a line consumers add to _their_
  `package.json` pointing at `build/scripts/install-assets.js`; see
  [examples/basic-extension/package.json](examples/basic-extension/package.json).
- [webpack-build-utils/build.js](webpack-build-utils/build.js) sets `config.mode` and appends
  `ZipPlugin` on the **array** exported by `webpack.config.js`, so neither actually reaches the three
  configs. Effective mode comes from `process.env.NODE_ENV`, which `build.js` sets to `production`.

### Verifying a change end to end

There is no dev server for the SDK itself. Both examples depend on it via `file:../../`:

```bash
npm run build                          # rebuild SDK bundles
cd examples/basic-extension
npm install && npm run build           # runs install-assets, then vite build → dist/
                                       # then load dist/ as an unpacked extension in Chrome
```

`examples/basic-extension` covers the extension-context path; `examples/web-app` covers the web-page
path (needs `extensionID`).

## Architecture

### Contexts and entry points

| Context               | Entry                                                        | Notes                                             |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Consumer page / popup | [src/ReclaimExtensionSDK.js](src/ReclaimExtensionSDK.js)     | Public API surface                                |
| Service worker        | [src/background/background.js](src/background/background.js) | `initBackground()` returns `ctx`                  |
| Content script        | [src/content/content.js](src/content/content.js)             | Runs in every tab, activates only in managed tabs |
| Page (MAIN world)     | [src/interceptor/](src/interceptor/)                         | `fetch`/`XHR` patching + `window.Reclaim` API     |
| Offscreen document    | [src/offscreen/offscreen.js](src/offscreen/offscreen.js)     | attestor-core WASM + WebSocket                    |

The SDK detects its own mode in the constructor: `chrome-extension:` protocol → `"extension"` (talks to
background via `chrome.runtime.sendMessage`), otherwise `"web"` (talks to the content script via
`window.postMessage`, and `extensionID` becomes mandatory).

### The verification pipeline

```
SDK.init()          → POST /api/sdk/init/session/  (ethers Wallet signs {providerId,timestamp}) → sessionId
startVerification() → START_VERIFICATION → sessionManager.startVerification
                        ├─ fetchProviderData(providerId) from api.reclaimprotocol.org
                        ├─ optional CSP-stripping DNR rule (cspRuleManager)
                        └─ chrome.tabs.create(loginUrl) → tab added to ctx.managedTabs
content script (managed tab) → injects network-interceptor + injection-scripts into MAIN world
interceptor → INTERCEPTED_REQUEST_AND_RESPONSE → content.filterInterceptedRequests()
                        (polls every NETWORK_FILTERING_INTERVAL_MS against providerData.requestData)
match → FILTERED_REQUEST_FOUND → ctx.processFilteredRequest (background.js)
                        ├─ attach cookies (cookieUtils) + pageOrigin
                        ├─ createClaimObject (claim-creator)
                        └─ proofQueue.addToProofGenerationQueue
proofQueue → generateProof → offscreen document → attestor-core → proof
all requestHashes satisfied → sessionManager.submitProofs → callbackUrl / PROOF_SUBMITTED
```

### Builder `api=2`

The public Builder entry points are `fromVerificationUrl()` and
`initBuilder()`. They accept only a URL whose query contains exactly `api=2`
and a non-empty `sessionId`; all other URLs stay on the legacy path. Builder
requests require the registered Verification Client UUID in
`x-reclaim-vc-id` and use Builder's direct Verification API.

The extension sends raw legacy `Proof` objects to Builder's `results` endpoint.
Builder owns terminal-event storage, outer-result signing, callback encryption,
and retries. Signing and encryption keys must never be added to extension code
or claimant diagnostics. The extension does not render Builder consent UI, so
consent-enabled sessions fail closed before opening a provider tab.

The generated client is under `src/generated/builder-bridge/` for compatibility
with the existing package layout; it is a Builder API client, not a backend
bridge. Run `npm run generate:builder-bridge` after the Builder OpenAPI contract
changes. Do not edit generated files. The generator reads
`BUILDER_OPENAPI`, then the adjacent Builder app contract, then the deployed
contract.

Non-obvious properties of this pipeline:

- **The background is single-session.** `ctx.activeSessionId` rejects a second concurrent
  `START_VERIFICATION`. The SDK therefore serializes calls through a module-level
  `_verificationQueue` in `ReclaimExtensionSDK.js`. Both guards exist; don't remove one assuming the
  other covers it.
- **Shared-context (`ctx`) pattern.** `initBackground()` builds one plain object holding all session
  state _and_ injected dependencies (`fetchProviderData`, `generateProof`, `MESSAGE_ACTIONS`,
  `loggingHub`, …), then binds module functions onto it (`ctx.failSession`, `ctx.submitProofs`). Every
  background module is a set of free functions taking `ctx` first — there are no classes and no module
  scope state. New session state belongs in the `ctx` literal _and_ in the reset block at the top of
  `sessionManager.startVerification`, which is what clears state between sessions.
- **Every terminal path must emit a terminal event.** The SDK's `startVerification()` returns a Promise
  resolved only by `completed`/`error`. Anything that ends a session (tab closed, provider error,
  concurrency rejection, `startVerification` throwing) has to route through `failSession` or send
  `PROOF_GENERATION_FAILED`, or the consumer's Promise hangs forever. `messageRouter` restores
  `ctx.sessionId` before calling `failSession` for exactly this reason — the SDK drops events whose
  `sessionId` doesn't match.
- **Timers.** `SessionTimerManager` starts only on the _first_ intercepted request
  (`ctx.firstRequestReceived`) and fails the session if no proof lands within
  `SESSION_TIMER_DURATION_MS`. It is _paused_ across proof generation, so the 30 s window never kills a
  proof. All tunables live in [src/utils/constants/config.js](src/utils/constants/config.js) — put new
  timeouts there, not inline.
- **The two proof timeouts are nested, and the outer one must stay the longer.**
  `PROOF_GENERATION_TIMEOUT_MS` (120 s) is the real budget — `offscreen.js` races
  `createClaimOnAttestor` against it. `PROOF_RESPONSE_TIMEOUT_MS` is the background waiting for the
  offscreen's reply, and is **derived** as `PROOF_GENERATION_TIMEOUT_MS + 15_000` rather than written as
  a literal, because it was once 60 s against an inner 120 s: the outer always won, a proof legitimately
  needing 60–120 s was killed while the offscreen was still working, and the inner timeout could never
  surface. The outer is now only a backstop for a document that died without answering.

  Both paths in [proof-generator.js](src/utils/proof-generator/proof-generator.js) reject with a real
  `Error` (via the local `rejection()` helper). They used to reject a bare `{success, error}` literal, so
  `error.message` in `proofQueue`'s catch was `undefined` — the session's one explanation of a proof
  timeout read `Proof generation failed: undefined`, and that string reached the consumer's Promise.
  `proofQueue` also reads `error?.message || error?.error` now, so the next plain-object rejection stays
  legible.

- **`expectManyClaims`** lets a provider script defer submission until it flips the flag off; that
  transition triggers `submitProofs` immediately if proofs are already queued.
- **The content script — and its popup — is destroyed and rebuilt on every navigation.** It is injected
  at `document_start` on each page, and a multi-request provider routinely walks several origins: the
  stock `example` provider goes example.org → example.com → jsonplaceholder, re-running
  `PROVIDER_DATA_READY`, the interceptor injection and the popup construction each time. **Nothing
  accumulated in content-script state survives a claim boundary.**

  The popup's claim counter learned this the hard way. It counted `totalClaims` from the
  `CLAIM_CREATION_REQUESTED` messages it personally saw and `completedClaims` from
  `PROOF_GENERATION_SUCCESS`, both starting at zero on every page — so a real 3-claim session showed
  `1/1`, flashed `2/1` (completed can exceed a per-page total), and finished by rendering
  `totalClaims/totalClaims`, i.e. `1/1` again. Session 2b46b57c39 generated and submitted all three
  proofs correctly the whole time; only the display was wrong.

  The background is the only context that spans the navigations, so it owns the numbers:
  [claim-progress.js](src/utils/claim-progress.js) `claimProgress(ctx)` returns
  `{completed: ctx.generatedProofs.size, total: max(requestData.length, completed)}` — bound as
  `ctx.claimProgress()` for `proofQueue`, per the shared-context pattern — and rides along in both
  messages' `data.progress`. The popup renders what it is given and falls back to its old increment only
  when the field is absent. `total` takes the _larger_ of the two because `expectManyClaims` can produce
  more claims than `requestData` declares, and a counter reading `4/3` is worse than one that grows.

  Its own module rather than a function in `background.js` so `node --test` can reach it: `background.js`
  uses extensionless imports, which webpack resolves and Node's ESM loader does not.

- **A rejected candidate is not a failed session.** Authoritative redaction resolution happens in the
  background, so it can legitimately conclude "this response doesn't carry the data yet".
  `processFilteredRequest` returns `{retryable: true}` for that case — no `failSession`, no
  `CLAIM_CREATION_FAILED` — `messageRouter` un-memoizes `ctx.filteredRequests`, and the content script
  pops the key back off `this.filteredRequests` so polling resumes. Skipping any one of those three
  stalls the flow until the session timer fires.

### The claim object must satisfy the attestor's schema exactly

`params` / `secretParams` are validated **server-side** by AJV against attestor-core's
`HttpProviderParameters` / `HttpProviderSecretParameters` (`src/types/providers.gen.ts`, applied in
`server/utils/validation.ts`). Both are `additionalProperties: false`, AJV runs `strict: true` with no
`removeAdditional`, so one unexpected key fails the whole claim with `ERROR_BAD_REQUEST: Params validation
failed` — at proof time, after the user has logged in, with the field named only inside an errors blob.

Provider documents legitimately carry fields that must **not** be forwarded (`order`, `description`,
`isOptional`, the legacy `responseSelections`), and that set grows independently of this SDK. So:

- [claim-shape.js](src/utils/claim-creator/claim-shape.js) `assertClaimShape()` is the last gate before the
  attestor: an **allowlist** of the schema's keys, plus string coercion of `paramValues` (a
  `customInjection` can hand back a number via `window.Reclaim`, which AJV rejects) and a required-field
  check. It strips rather than throws — a dropped unknown field still yields an acceptable claim, whereas
  failing the session denies a verification over a field the attestor would have ignored.
- `responseRedactions` is likewise built as an allowlist (`xPath`, `jsonPath`, `regex`, `hash`). Empty
  `xPath`/`jsonPath` are omitted, not sent as `""`.
- **Never add a field to `params` without checking the schema first.**

**Hash-bearing params stay in `params.paramValues` — do not force them secret.** It looks like a privacy
win and breaks OPRF two ways: the attestor verifies response matches via
`substituteParamValues(rawParams, undefined, true)` — `secretParams` is _undefined_ there, and
`ignoreMissingParams` makes an unresolved `{{param}}` return **literally**, so the match is compared
verbatim and never matches; and `updateParametersFromOprfData` (default `true`) replaces the raw value with
the OPRF nullifier inside `params` only. Privacy comes from that client-side substitution, not from hiding
the param. InApp splits on the name containing `SECRET` and nothing else — match that.

### Provider values wider than this SDK supports

[provider-normalization.js](src/utils/provider-normalization.js) coerces provider config to what the
extension actually implements, at the point the provider is fetched, logging every coercion:

| field                       | upstream value space                       | supported here                                       | fallback                                                                                                                                        |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `injectionType`             | `MSWJS \| XHOOK \| HAWKEYE \| NONE \| CDP` | `HAWKEYE` (inject the interceptor), `NONE` (don't)   | **`HAWKEYE`** — matches InApp's `defaultValue`. Never default to `NONE`: that silently disables interception and the session dies on the timer. |
| `responseRedactions[].hash` | `oprf \| oprf-mpc \| oprf-raw`             | `oprf-raw`                                           | **`oprf-raw`** for any other truthy value. Absent/`null` must stay absent — coercing it would hash a value the provider meant to reveal.        |
| `requestData[].urlType`     | `REGEX \| CONSTANT \| TEMPLATE`            | all three (`CONSTANT`/`EXACT` compare, others regex) | **inferred from the url** like InApp does: `TEMPLATE` if it contains `{{`, else `CONSTANT`. Never refuse to match — see below.                  |

`injectionType` is normalized in `sessionManager.startVerification` right after `fetchProviderData`, so
every downstream consumer sees a supported value; `messageRouter` sends `DEFAULT_INJECTION_TYPE` rather
than `null` when there is no provider data.

`urlType` is normalized where it is _used_ instead — in `matchesRequestCriteria`
([network-filter.js](src/utils/claim-creator/network-filter.js)), the one place it decides anything. Two
things to know:

- **There is no `EXACT` upstream.** The enum is `REGEX | CONSTANT | TEMPLATE` (InApp `UrlType`).
  `EXACT` is local to this SDK — `matchesRequestCriteria`'s historical default, and what the background
  writes on synthetic requests — so it is kept as an alias for `CONSTANT`, not removed.
- **An unrecognised `urlType` must never mean "no match".** This branch used to `return false` for
  anything outside its list, and `CONSTANT` — upstream's _default_, what InApp infers for any url without
  `{{` — was outside it. A provider carrying it matched no request at all: no claim, no proof, and no
  diagnostic past `REQUEST_INTERCEPTED`, because everything that logs about extraction runs only _after_ a
  match. It failed on the session timer looking exactly like "the user never logged in". Guessing wrong
  costs one non-matching request; refusing to match costs the whole verification, so unknown values are
  inferred from the url.

#### The gate reports which check rejected a request

This gate is upstream of every extraction log, so a provider that matches nothing used to be the one
failure mode with no signal at all: the six `return false` points were silent, and a stale `bodySniff`
template produced a session identical to "the user never logged in".

`describeRequestMatch()` is now the real entry point and returns `{matched, stage, detail}`;
`filterRequest()` is a thin boolean wrapper kept for callers that only need the verdict. `stage` is a
member of `MATCH_STAGES`, ordered by `MATCH_STAGE_ORDER` (`url → method → body → responseMissing →
responseMatch → responseRedaction → matched`), so **reaching stage N means every check before N passed** —
that ordering is what the content script's counters are built on.

- **`detail` becomes a log line, and log lines are never redacted.** Only provider-authored patterns
  (the url template, `bodySniff.template`, `match.value`, a redaction's `jsonPath`/`regex`) and _sizes_
  may appear in it. Never the request body, never the response. `network-filter.test.js` pins this.
- **Only near misses are logged individually.** `content.js` `reportMatchAttempt()` skips
  `MATCH_STAGES.URL` — 32 of 33 requests in a typical page load die there and it says nothing the
  `REQUEST_INTERCEPTED` line doesn't. `responseMissing` is FINE, being the normal state on the tick
  between a request and its response. Everything else is INFO.
- **Reporting is keyed on advancement, not on evaluation.** Filtering re-runs every
  `NETWORK_FILTERING_INTERVAL_MS` over the same request map for the life of the session, so
  `this.matchProgress` (`"<matcherIndex>|<requestKey>"` → furthest stage index) gates each line to the
  first time that pair gets that far. A request legitimately advances when its response arrives, so
  dedupe on "seen" rather than "advanced" would suppress the interesting outcome.

`reportNoMatchSummary()` closes the loop with one line per matcher (`N seen, N url-matched,
N method-matched, N body-matched, N fully matched`), fired by a content-script timer armed in
`startNetworkFiltering` and disarmed on the first match. This is the "no request ever matched" timer
`RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION` was waiting for — but it carries that event type
**only when nothing was intercepted at all**. With traffic seen it emits
`CLAIM_CREATION_TIMED_OUT_EXCEPTION`, which is what the background's session timer already calls the same
outcome. Deliberately **not** `FILTER_REQUEST_ERROR`: that marks a _thrown_ filtering error
(`background.js`), and folding a clean non-match into it would break that query.

The background's `SessionTimerManager` cannot do this job — it starts only on the first intercepted
request, so it cannot tell "no traffic" from "traffic, none matching", and the counters live in the
content script anyway.

### Vendored attestor code — must be re-synced by hand

A provider's `xPath` / `jsonPath` / `regex` is authored once and must resolve **identically** in
attestor-core, the InApp SDK, and this extension. To guarantee that, the extraction primitives are a
verbatim copy of the attestor's, not a reimplementation:

| file                                                                                   | upstream source                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [vendor/attestor-http-utils.js](src/utils/claim-creator/vendor/attestor-http-utils.js) | attestor-core `src/providers/http/utils.ts` (extraction half)                            |
| [vendor/patch-parse5-tree.js](src/utils/claim-creator/vendor/patch-parse5-tree.js)     | attestor-core `src/providers/http/patch-parse5-tree.ts`                                  |
| [attestor-extraction.js](src/utils/claim-creator/attestor-extraction.js)               | mirrors the private `processRedactionRequest` generator in `src/providers/http/index.ts` |
| [make-regex.js](src/utils/claim-creator/make-regex.js)                                 | `makeRegex`, using the attestor's browser `re2` fallback semantics                       |

Rules:

- **Do not "improve" the vendored files.** Any local edit silently breaks cross-SDK parity. Deviations are
  allowed only where the environment forces them, and each is commented (currently only `makeRegex`, which
  is `new RegExp(str, "sgi")` rather than `RE2(str, 'sgiu')` — the attestor's own browser build does the
  same, and webpack aliases `re2: false` here anyway).
- **After re-syncing, run `npm test`.**
  [attestor-parity.test.js](src/utils/claim-creator/attestor-parity.test.js) drives the _installed_
  attestor through its `./external-rpc` `handleIncomingMessage` surface and diffs it against the copy, so
  it catches real divergence rather than just re-asserting copied expectations.
- The parsers (`xpath`, `parse5`, `parse5-htmlparser2-tree-adapter`, `domhandler`, `esprima-next`) are
  pinned to the attestor's exact ranges. Bump them together with a re-sync, not independently.
- **Keep them out of the content bundle.** They have import-time side effects (`patch-parse5-tree` mutates
  `domhandler` prototypes) so webpack cannot tree-shake them, and the content script is injected at
  `document_start` on every page of every site. That's why `content.js` imports `filterRequest` from
  `claim-creator/network-filter` directly rather than the `claim-creator` barrel, why `makeRegex` lives in
  its own module, and why the content-script gate has no `xPath` branch at all.

Why vendored rather than imported, now that the pinned 5.1.1 _does_ export the extractors
([PR #92](https://github.com/reclaimprotocol/attestor-core/pull/92)): `makeRegex` and the
`processRedactionRequest` redaction chain are still not in that export set, so local copies are needed
either way — and a half-imported, half-copied chain is harder to keep in lockstep than a wholly copied
one `attestor-parity.test.js` can diff end to end. That test runs on 5.1.1 (it skipped on 5.0.5), so the
copies are now checked against the real attestor on every `npm test` rather than trusted.

### attestor-core is pinned to `5.1.3` exactly — do not bump it casually

`@reclaimprotocol/attestor-core` is pinned **without `^`**. Two independent regressions in the 5.0.x/5.1.x
line make several versions unusable, and neither fails at install time:

| version      | `./browser` bundle ships | bundle registers `stwo` |
| ------------ | ------------------------ | ----------------------- |
| 5.0.5        | yes                      | yes                     |
| 5.0.6        | yes                      | **no**                  |
| 5.0.7        | yes                      | **no**                  |
| 5.0.8        | yes                      | **no**                  |
| 5.1.0-dev.1  | yes                      | yes (but a prerelease)  |
| 5.1.0        | **no — 404**             | n/a                     |
| 5.1.1        | yes                      | yes                     |
| **5.1.3** ✅ | yes                      | **yes**                 |

- 5.1.0 dropped `browser/resources/attestor-browser.min.mjs` from the tarball (unpacked size
  2.64 MB → 1.02 MB) while still declaring `exports["./browser"]`, which
  [offscreen.js](src/offscreen/offscreen.js) imports. Resolution fails at build time. 5.1.1 restored it
  (2.58 MB unpacked, 1.55 MB bundle).
- 5.1.1 still failed OPRF proofs server-side with
  `oprf-raw cross-block markers incomplete: pending for packets N` on responses whose OPRF-marked region
  straddles TLS record boundaries — intermittently, so a provider could pass one run and fail the next.
  Patched in **5.1.3**. The error text appears in no client bundle: it is raised by the attestor
  service, reaching the offscreen document as `recv claim response {success: false}` _after_ the ZK
  proofs have already generated. Do not go back below 5.1.3.
- 5.0.6–5.0.8 still ship that bundle, but it no longer registers a ZK operator maker for `stwo` — the
  engine [config.js](src/utils/constants/config.js) `DEFAULT_ZK_ENGINE` selects. Nothing complains until
  proof time, when the offscreen document throws
  `Proof generation failed: No ZK operator maker for stwo` — _after_ the user has logged into the
  provider. `browser/resources/*.mjs` is a checked-in artifact built by a separate step upstream, which is
  how its contents drift between patch releases.

[attestor-zk-engine.test.js](src/utils/claim-creator/attestor-zk-engine.test.js) guards both: it asserts
the pinned version ships the bundle and that the bundle references `DEFAULT_ZK_ENGINE`. **Run `npm test`
after any attestor bump** — that test turns both regressions from a runtime failure into a test failure.

**What a bump has to be checked against**, beyond that test — all of it re-verified for 5.1.3:

- `exports["./browser"]` resolves and the bundle exports `createClaimOnAttestor`
  ([offscreen.js](src/offscreen/offscreen.js)); `exports["./external-rpc"]` exports
  `handleIncomingMessage` (the parity test's only route in).
- The ZK operator-maker registry in the **built** `build/offscreen/offscreen.bundle.js` — not just the
  package's copy — has a top-level `stwo` key. That is the object the
  `No ZK operator maker for ${engine}` throw reads.
- `CreateClaimOnAttestorOpts` still intersects `PrepareZKProofsBaseOpts`, which is what puts `zkEngine`
  at the top level of the object [claim-creator.js](src/utils/claim-creator/claim-creator.js) builds, and
  `updateParametersFromOprfData` still exists (the OPRF note above depends on its default).
- `HttpProviderParameters` / `HttpProviderSecretParameters` in `lib/types/providers.gen.d.ts` against the
  allowlists in [claim-shape.js](src/utils/claim-creator/claim-shape.js). Note
  `supportedProtocolVersions`, added in the 5.1 line, is nested under `additionalClientOptions`, not
  top-level — the allowlists still match exactly.

  5.1.1 also ships `lib/` as **ESM**. On 5.0.5 those were esbuild bundles doing named imports from the
  CommonJS `@reclaimprotocol/tls`, which Node's ESM loader refuses, so the package could not be loaded
  under Node and [attestor-parity.test.js](src/utils/claim-creator/attestor-parity.test.js) — the
  differential check of the vendored extraction code against the real attestor — **skipped**. It now runs
  and passes, which is the strongest available evidence that the vendored copies are still in sync. The
  suite went 148 tests/1 skipped → 159 tests/0 skipped on this bump alone. The skip path is kept in case a
  future pin regresses to the CJS shape.

### Messaging

Three separate action vocabularies, all in [src/utils/constants/interfaces.js](src/utils/constants/interfaces.js):

- `RECLAIM_SDK_ACTIONS` (`RECLAIM_*`) — web page ↔ content script over `window.postMessage`.
- `MESSAGE_ACTIONS` — content ↔ background ↔ offscreen over `chrome.runtime` / `chrome.tabs`.
- `MESSAGE_SOURCES` — every internal message carries `{action, source, target, data}`, and
  [messageRouter.js](src/background/messageRouter.js) validates `source`/`target` plus
  `ctx.managedTabs.has(sender.tab.id)` before acting. Adding a handler means adding a case _and_
  the matching guard; unmanaged tabs must be rejected.

### Provider-facing page API

[injection-scripts.js](src/interceptor/injection-scripts.js) installs `window.Reclaim` in the MAIN world
for provider-authored `customInjection` scripts: `parameters` (getter), `getParametersSync()`,
`updatePublicData()`, `canExpectManyClaims()`, `reportProviderError()`, `requestClaim()`. Each posts a
`RECLAIM_*` message that the content script forwards to background. Changing these signatures breaks
published provider scripts.

### CSP stripping

When `providerData.extensionConfig.allowInjectionsViaChromeScripting` is set, `cspRuleManager` adds a
`declarativeNetRequest` **session** rule (fixed id `CSP_RULE_ID = 9999`) that strips the provider
origin's CSP so `chrome.scripting.executeScript` can `eval` the custom injection in the MAIN world. It
is removed on session end, on tab close, on `startVerification` failure, at background init (orphan
cleanup), and by a `CSP_RULE_MAX_LIFETIME_MS` safety timer. Any new exit path needs the same cleanup.

### Offscreen document

`installOffscreenReadyListener()` runs at background init; `ensureOffscreenDocument()` creates the
document on demand and waits for `OFFSCREEN_DOCUMENT_READY`. Proof generation is only reachable through
`GENERATE_PROOF` / `GENERATE_PROOF_RESPONSE` messages — the offscreen document exists because
attestor-core needs WASM, real WebSockets, and `crypto.getRandomValues`, none of which are usable
directly from an MV3 service worker.

## Build output and bundle-format constraints

Three webpack configs in [webpack.config.js](webpack.config.js), all writing into a single `build/`
(`clean: false` after the first, so build order matters):

1. `extension-classic` — content script as **UMD** (`ReclaimContent`), interceptor + offscreen as
   classic scripts. The content script must not be ESM: an MV3 `content_scripts` entry loading an
   ES module fails with `Unexpected token 'export'`.
2. `background-esm-mv3` — `background/background.bundle.js` + `ReclaimExtensionSDK.bundle.js` as ES
   modules (`output.module`, `experiments.outputModule`).
3. `background-commonjs-mv2` — the same two entries as `*-mv2.bundle.js` in CommonJS for Firefox/MV2.

attestor-core drags in Node built-ins, so `commonResolve` aliases `koffi`/`re2`/`snarkjs` to `false`,
maps `worker_threads`/`jsdom`/`module` to stubs in [src/utils/mocks/](src/utils/mocks/), and points `ws`
at [websocket-polyfill.js](src/utils/websocket-polyfill.js). The same exclusions are duplicated in
`package.json`'s `overrides` and `browser` fields — a new native-dep failure usually needs entries in
both places. `ignoreWarnings` in the first config deliberately silences the resulting resolution noise.

`__SDK_VERSION__` is a DefinePlugin global injected from `package.json`; the SDK reports it as
`ext-<version>` in `sdkVersion`.

## Logging

Background writes directly to the singleton `loggingHub`; content and offscreen use
`createRemoteLogger("content" | "offscreen")`, which forwards `LOG_MESSAGE` to the hub so all logs are
enriched with one session context and batched to the remote endpoint.

```javascript
// background
import { loggingHub } from "../utils/logger/LoggingHub";
loggingHub.info(message, "background.verification"); // also .debug / .warn / .error

// content or offscreen
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
const logger = createRemoteLogger("content");
```

MAIN-world scripts (`src/interceptor/`) have no `chrome.runtime`, so they use
[log-bridge.js](src/interceptor/log-bridge.js) `createPageLogger(context, category)`, which
`window.postMessage`s `RECLAIM_LOG`; `content.js` relays it via `logger.relay()` with the _originating_
context preserved. Never add a bare `console.log` in the interceptor — it would reach neither the
endpoint nor the config gate.

The second argument is a dotted category (`background.claim`, `background.csp`, …) used for filtering
downstream — reuse an existing one where it fits. `loggingHub.setSessionContext()` is called on
`START_VERIFICATION`; `clearSessionContext()` is `await`ed on every terminal path and **flushes first**,
because a terminal event is exactly when the worker is most likely to be torn down.

- **`flush()` is serialized, never skipped, and must stay that way.** It chains each call onto the
  previous one instead of returning early while a POST is in flight. Returning early loses the caller's
  batch, and the two callers that overlap in practice are the periodic flush and the terminal
  `clearSessionContext()` — so the dropped batch is the end of a failed session, the only part that
  explains the failure. This was a real loss: a session's logs stopped dead at the last periodic flush and
  the proof-failure tail never reached the endpoint, while the console showed it all. `forceFlush()` is now
  just `flush()`; the previous version polled `isFlushing` for one second and then called a `flush()` that
  no-opped anyway. [logging-hub.test.js](src/utils/logger/logging-hub.test.js) `"never skips a batch"`
  keeps a slow (1.2 s) first POST in the way of a terminal flush and fails if the terminal batch vanishes.
- **`clearSessionContext()` keeps the identifiers.** A terminal path is not the last thing that logs —
  `failSession` goes on to notify tabs, broadcast to the popup and answer further messages. Nulling the
  ids stamped those `"unknown"`, which makes them unreachable from a `sessionId` query and therefore
  invisible in the legacy log viewer. `sessionEnded` records the transition instead; the next
  `setSessionContext()` overwrites the ids. Over-attributing a stray inter-session line is much cheaper
  than losing the failure tail.
- **`alarms` is in the recommended consumer manifest.** Without it `_startFlushSchedule()` falls back to
  `setInterval`, which Chrome destroys along with the service worker. The fallback stays (no consumer is
  forced to change a manifest) but the example manifest and `readme.md` now ask for the permission.

Non-obvious properties:

- **One threshold, and it decides redaction.** `config.logLevel` governs the console _and_ the endpoint,
  and the two destinations always receive the same text. `INFO` (the default) redacts every payload;
  `FINE` serialises it raw. `config.consoleEnabled` is independent and only mirrors lines locally.

  There used to be a second threshold, `remoteLogLevel`, defaulting to `DEBUG` so "everything ships".
  Combined with a destination-based redaction split (console raw, endpoint redacted) it could not express
  the property that actually matters — _no user data anywhere at the default level_ — and in practice it
  published `claimData.context.extractedParameters` (the plaintext value being proven) to Loki on every
  successful session. Don't reintroduce it: the way to get more detail is to raise `logLevel` to `FINE`,
  which is also the switch that stops redacting.

- **Levels use the platform's spelling: `SEVERE` → `WARNING` → `INFO` → `FINE`.** The InApp SDK, the
  Portal and the log viewer all speak Java-style levels, and the logs API only accepts
  `fine | config | info | warning | severe` when filtering by severity — the old `ERROR`/`WARN`/`DEBUG`
  spellings made extension sessions unfilterable next to everyone else's. `normalizeLogLevel()` in
  [logger/constants.js](src/utils/logger/constants.js) still resolves the old names (and `CONFIG`,
  `FINER`, `FINEST`) so a persisted consumer config keeps working. The method names are unchanged —
  `loggingHub.debug()` emits `FINE`, `.error()` emits `SEVERE` — because every call site uses them;
  `.fine()` exists as an alias.

  `WARNING` and `SEVERE` are _more_ severe than `INFO`, so they are always visible at the default. The
  labels exist so one query can isolate failures, never to hide them.

- **The queue is mirrored to `chrome.storage.session`** on every change and drained at hub init. MV3 kills
  the worker without warning and `onSuspend` is unreliable, so an in-memory-only queue loses precisely
  the logs that explain a crash. `chrome.alarms` is used for the periodic flush when the consumer's
  manifest grants it, with `setInterval` as the fallback so no manifest change is forced.
- **The hub starts lazily.** `ReclaimExtensionSDK.js` imports `background.js` at module scope, so eager
  construction would start a flush schedule in every consumer popup and web page.
- **Every entry carries `source`** — the versioned identity from
  [client-source.js](src/utils/logger/client-source.js), e.g.
  `browser-extension-sdk sdk/v0.4.2 (chrome/141,<ext-id>/v1.0.0)` — plus `context`
  (background|content|offscreen|interceptor|injection), `sessionId`, `providerId`, `appId`. The grammar
  mirrors the InApp SDK's `getClientSource()`; the team's SDK-identification rule is a substring check for
  `browser-extension-sdk`, so no code path may produce a string without it.
- **Redaction follows the _level_, not the destination.** Pass structured data as the third argument —
  `loggingHub.info("Starting:", "background.verification", { payload: templateData })`. At `INFO` the hub
  redacts it once and hands that same redacted copy to both the console (as a second console arg, so
  devtools still renders a tree) and the endpoint, capped at `LOG_MAX_LINE_LENGTH`. At `FINE` both get the
  raw object, capped at `LOG_MAX_UNREDACTED_LINE_LENGTH`. `RemoteLogger`/`relay()`/the page bridge all
  carry `payload` as an object across the boundary (structured-cloned) so this holds for every context.

  The console deliberately gets a redacted _copy_ rather than the caller's object at `INFO`: the
  content-script console is the **provider tab's** console, so "the console always shows everything" meant
  a consumer who enabled it was printing the user's own extracted data into the site they were logged in
  to.

  **Never pre-stringify at the call site** — `info("x: " + JSON.stringify(obj))` sends whatever `obj`
  holds straight to Loki. The router used to do exactly that with the whole `templateData`, publishing the
  session `signature` and the user's `parameters`. `redact.js` matches sensitive keys by substring
  (`signature`, `secret`, `token`, …) and blanks the _values_ of `parameters`/`paramValues` while keeping
  their key names, which is usually the actual diagnostic question.

  **Response content is never allowed in a message string.** `RedactionResolveError` used to interpolate
  up to 200 characters of the matched element into its message
  (`regexp X does not match found element '<...>'`), and that message becomes the `logLine` — so every
  regex miss on a matched request published a slice of the user's authenticated page to Loki. Key-based
  redaction cannot save free text in `message`. The content now travels as `error.element` and is passed
  through the log **payload**; `RESPONSE_CONTENT_KEYS` in [redact.js](src/utils/logger/redact.js) replaces
  such string values with `<redacted:N chars>` at `INFO`. That list is deliberately narrow — bare `body` is
  excluded, because a claim's `params.body` is a provider-authored template worth reading, not user data.

  The backend redacts unconditionally too
  ([sanitize.ts](../devtools/reclaim-logs-backend/src/utils/sanitize.ts) blanks `deviceId`, `publicIpAddress`,
  `userAgent`, `metadata` on every `logDump`) — but it never touches `logLine`, so anything embedded in a
  message string reaches Loki verbatim regardless.

- **Two shapes redaction handles specially, both learned from real leaks.**

  `OPAQUE_KEYS` (`claimData`, `context`, `extractedParameters`, `injectionResult`) are replaced whole with
  `[REDACTED]` rather than walked into. `claimData` is the attestor's claim, and `claimData.context`
  carries `extractedParameters` — the plaintext value the user is proving. Descending key-by-key would
  expose every field the attestor adds in future until someone remembered to list it, and the InApp SDK
  blanks exactly this field in its own `PROOF_GENERATED` line, so a redacted proof reads the same across
  SDKs: identifier, signatures, witnesses and `providerRequest` survive, the payload does not.

  `USER_DATA_KEYS` are matched **whatever the value's type is**. The attestor hands `parameters`,
  `publicData` and friends back as JSON _strings_, and an `isUserData(key) && typeof val === "object"`
  guard let those blobs through untouched — which is how the proven value reached Loki on every successful
  session. An object keeps its key names (`<redacted keys: username>`); a string keeps only its length.

- **The full-claim dumps are just `FINE` now.** [claim-creator.js](src/utils/claim-creator/claim-creator.js)
  after `assertClaimShape`, and [offscreen.js](src/offscreen/offscreen.js) immediately before
  `createClaimOnAttestor` — the latter being the only view of the object that actually reached the
  attestor, after `sessionId` is stripped and the chrome-messaging hop. An attestor-side rejection
  (`Params validation failed`, a response match that never matches) is diagnosable only from the exact
  bytes sent, and the redacted form blanks `secretParams`, `paramValues` and `ownerPrivateKey` — the fields
  most likely to be at fault.

  These used to carry a per-call `unredacted: true` flag with its own gate. That flag is **gone**: the
  level decides, so there is no longer a way for a call site to opt out of redaction independently of the
  configured level. `LOG_MAX_UNREDACTED_LINE_LENGTH` (100 000, vs `LOG_MAX_LINE_LENGTH` 2000) now applies
  to any `FINE` payload, since a real claim runs well past 2000 characters.

  [logging-hub.test.js](src/utils/logger/logging-hub.test.js) `"no user data reaches the endpoint at the
default level"` pins the corners: claim blanked at the stock defaults, `claimData` blanked inside a
  submitted proof, a provider script's return value blanked whatever keys it invents, the message itself
  preserved, and all of it raw at `FINE` including across the relay.

- **Why the matched request failed is reported per stage.** `RedactionResolveError` carries `stage`
  (`xPath` | `jsonPath` | `regex` | `responseMatch` | `redaction`), and `reportExtractionFailure` in
  [background.js](src/background/background.js) maps it to the InApp SDK's own four names —
  `X_PATH_MATCH_REQUIREMENT_FAILED` / `JSON_PATH_MATCH_REQUIREMENT_FAILED` (error) and
  `REGEX_MATCH_REQUIREMENT_FAILED` / `NO_RESPONSE_MATCH_WARNING` (warning), matching
  `claim_creation.dart`'s severities so one query spans both SDKs. This lives in the background because
  that is the only place authoritative resolution happens, and it therefore only ever runs for a request
  the content gate already matched — the content gate itself must stay a cheap presence check. Only one
  stage can fail per attempt, so this re-labels the single line that was already emitted rather than
  multiplying it; repeats of the same `(requestHash, stage, message)` drop to `FINE` via
  `ctx.reportedExtractionFailures`, because the content script re-polls every
  `NETWORK_FILTERING_INTERVAL_MS` for the life of the session timer.
- **Extraction success is reported too, and it is INFO.** For a long time only _failures_ were, so a
  selector that resolved to the wrong region — or to an empty string — looked exactly like one that was
  never evaluated, and the session's only extraction line was
  `[PARAM-EXTRACTOR] Validating N response match(es)`. `extractParamsFromResponse`
  ([params-extractor.js](src/utils/claim-creator/params-extractor.js)) now emits a line per resolved
  redaction (`Redaction #0 resolved via jsonPath: $.user.userName → 1 slice(s) [len=24]`) and per
  satisfied responseMatch, plus the `Resolved N param(s)` summary — all carrying the provider's selector
  and the value's **length**, never the value.

  What makes INFO safe here is that the values ride the log **payload** under the key
  `extractedParameters`, which is in `OPAQUE_KEYS`: `[REDACTED]` at INFO, raw at FINE. Keep new
  extraction logging to that shape — a value interpolated into the message string would reach Loki
  verbatim on every successful session, which is the exact regression `redact.js` exists to prevent.

- **`SessionTimerManager` logs through the hub.** [session-timer.js](src/utils/session-timer.js) is
  imported only by `background.js`, so it can import `loggingHub` directly without breaking the hub's
  lazy start. Its lines were bare `console.log` — simultaneously the only part of the flow visible in a
  stock local console and the only part unreachable from a `sessionId` query.

  [polyfills.js](src/utils/polyfills.js) **cannot** do the same: it is imported by
  `ReclaimExtensionSDK.js`, so it runs in the consumer's own web page, where importing the hub would
  start a flush schedule (and `createRemoteLogger` has no `chrome.runtime`). Its happy-path chatter was
  removed instead; the `console.warn`/`console.error` failure paths stay.

- **Dedupe counts, it doesn't discard**: a repeat inside `LOG_DEDUPE_WINDOW_MS` bumps `repeated` on the
  queued entry. The key is `context|level|message|type`, so the same wording from two contexts stays two
  entries.

Log level and console output come from `chrome.storage.local` under `LOG_CONFIG_STORAGE_KEY` and can be
set by consumers via `reclaimExtensionSDK.setLogConfig()` or `init(..., { logConfig })`. Defaults:
`logLevel: "INFO"`, `consoleEnabled: false` — nothing sensitive is collected and the console stays quiet
until asked, because the content-script console is the _provider tab's_ console and a consumer extension
ships to end users. For local work: `setLogConfig({ consoleEnabled: true, logLevel: "FINE" })`.

`FINE` sends response bodies, extracted values, the full claim (owner private key, session cookies) and
the full proof **to the endpoint as well** — that is the point of it, since a client's failing session has
to be diagnosable remotely. It is the same trade the Portal makes with its per-session `log: true` flag.
Prefer setting it per verification via `init(..., { logConfig })` rather than leaving it on a device.

`content.js` pushes the config into the MAIN world as `RECLAIM_LOG_CONFIG`, since the page world cannot
read `chrome.storage` itself. [log-bridge.js](src/interceptor/log-bridge.js) therefore keeps its own copy
of the defaults — **keep the two in sync**; it cannot import them, being dependency-free by design.

### `eventType` — the cross-SDK taxonomy

`EVENT_TYPES` in [logger/constants.js](src/utils/logger/constants.js) is reconciled against the InApp
SDK's `LogEventType` (`reclaim-inapp-sdk/lib/src/logging/event_type.dart`). **If a name exists upstream,
spell it the same way** — the point is that one Grafana query spans both SDKs. Before adding a name, look
for one that already means the same thing; the file's header records the renames already made, and
[logging-hub.test.js](src/utils/logger/logging-hub.test.js) fails if a retired extension-local name
(`CLAIM_CREATION_SUCCESS`, `VERIFICATION_FLOW_FAILED`, …) comes back.

Pass it alongside the category, both being separate axes — `eventType` answers "where in the flow",
`type` answers "which module":

```javascript
loggingHub.info("[BACKGROUND] Fetched provider data …", "background.provider", {
  eventType: EVENT_TYPES.FETCHED_PROVIDERS,
});
```

`EVENT_TYPES` reaches the background modules through `ctx` (they take `ctx` first and import nothing —
see the shared-context pattern above); `proofQueue` destructures it. Entries default to `"UNKNOWN"` rather
than omitting the field, so it can be a Loki label without holes. MAIN-world callers use the bridge's
`debug.event(EVENT_TYPES.X, …)`, kept separate from the level methods so the variadic console-style
signature stays intact.

`failSession(ctx, message, requestHash, eventType)` takes an optional event type, defaulting to
`RECLAIM_EXCEPTION`. The session timer passes `CLAIM_CREATION_TIMED_OUT_EXCEPTION` — and note it can only
fire _after_ the first intercepted request, which is why
`RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION` is emitted from the **content script's** no-match
timer instead, and only when nothing was ever intercepted. See "The gate reports which check rejected a
request" above.

## `reclaim-api-client`

Every request to a **Reclaim-owned** endpoint carries `reclaim-api-client: <client source>`, matching what
the InApp SDK and Verifier app send — `fetchProviderData`, `updateSessionStatus`
([fetch-calls.js](src/utils/fetch-calls.js)), `_initSession`
([ReclaimExtensionSDK.js](src/ReclaimExtensionSDK.js)), and the `logDump` POST.

Deliberately **not** on `submitProofOnCallback`: `submitUrl` is the consumer's own server, `Content-Type:
text/plain` keeps that a CORS-safelisted "simple" request today, and adding a custom header would force an
OPTIONS preflight arbitrary consumer servers need not answer. Both Reclaim backends run `cors()` with
defaults, so they reflect the header on preflight — verified, but re-check before adding the header to a
new host.

Per the team's guideline the extension contributes **no device information to analytics**: request bodies
are unchanged, so `deviceId`/`deviceType` stay absent and the backend records them as `NA`. The extension
emits no `appLogs` of its own — the `USER_STARTED_VERIFICATION` analytics row is created server-side by
reclaim-sdk-backend in response to `updateSessionStatus`, and there is no extension equivalent of InApp's
`FETCHED_PROVIDERS`.

## Documentation map

[readme.md](readme.md) is the consumer-facing integration guide. The module
READMEs describe implementation boundaries and current entry points:
[background](src/background/README.md), [content](src/content/README.md),
[offscreen](src/offscreen/README.md), and [logger](src/utils/logger/README.md).
Keep examples aligned with exported symbols and the message constants.
