# Background service

The background bundle owns the verification session. It runs in the consumer's
service worker and coordinates content scripts, provider tabs, the offscreen
proof generator, and result delivery.

## Entry points

- `background.js` creates the shared `ctx` object, registers Chrome listeners,
  and binds the session, tab, proof-queue, and message-router modules.
- `messageRouter.js` validates message sources and dispatches
  `MESSAGE_ACTIONS`.
- `sessionManager.js` starts, completes, fails, and cancels sessions.
- `proofQueue.js` generates proofs sequentially and calls `ctx.submitProofs()`
  when all required requests are complete.
- `tabManager.js` tracks managed provider tabs.
- `cookieUtils.js` reads cookies for the matched request URL and filters them
  by domain, path, and security attributes.

## Shared context

Background modules are functions that receive `ctx` as their first argument.
Keep session state in the `ctx` literal and reset it in
`sessionManager.startVerification()`. Do not add module-level session state;
the service worker can handle only one active session at a time.

```js
const ctx = {
  activeSessionId: null,
  providerData: null,
  managedTabs: new Set(),
  generatedProofs: new Map(),
  fetchProviderData,
  generateProof,
};
```

Every terminal path must call `failSession()`, `submitProofs()`, or the
corresponding Builder result operation. The public request Promise resolves
only after a terminal message; returning without one leaves consumers waiting
indefinitely.

## Message flow

```text
content script → messageRouter → sessionManager/proofQueue
background     → content script (provider data and status)
background     → offscreen document (claim and proof messages)
```

Use the constants in `src/utils/constants/interfaces.js`; do not duplicate
action strings. `handleMessage()` returns `true` when a handler replies
asynchronously.

## Builder `api=2`

An exact `api=2` verification URL selects the Builder mode. The background
bootstraps the session from Builder's direct Verification API and sends
`x-reclaim-vc-id` on every Builder request. The header is a public routing
identifier, not an authentication credential. It submits raw legacy `Proof`
objects to Builder. Builder records the terminal result, signs the outer
result, encrypts callback deliveries when configured, and owns retries.

Builder mode does not use the legacy session-status or callback endpoints. URLs
without exact `api=2` keep the legacy flow unchanged. The Builder consent UI is
not implemented in this bundle; a session that requires consent fails closed
before its provider tab opens.

## Cleanup rules

- Clear session timers and CSP-stripping rules on every terminal path.
- Remove a managed tab before starting the next Builder provider.
- Keep `ctx.activeSessionId` and the SDK verification queue in sync. They are
  separate guards for the single-session background.
- Use `ctx.claimProgress()` for progress messages so counts survive page
  navigations inside one verification.
