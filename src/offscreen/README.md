# Offscreen document

The offscreen document runs the browser build of `@reclaimprotocol/attestor-core`
outside the service worker. It is responsible for proof generation and private
key creation; the background service remains responsible for session state and
result delivery.

## Runtime setup

`offscreen.js`:

- sets `global.WASM_PATH` to the extension's public URL;
- adds the COOP/COEP meta tags required by the proof runtime;
- installs the browser WebSocket implementation; and
- reports readiness before handling proof messages.

The consumer manifest must grant `offscreen`, allow `wasm-unsafe-eval` for
extension pages, and expose `offscreen.html`, `offscreen.bundle.js`, and the
required circuit assets. See the root `readme.md` for the complete manifest.

## Messages

The background sends:

- `PING_OFFSCREEN` to check readiness;
- `GENERATE_PROOF` with the claim object; and
- `GET_PRIVATE_KEY` to request a fresh 32-byte private key.

The document sends `OFFSCREEN_DOCUMENT_READY`,
`GENERATE_PROOF_RESPONSE`, and `GET_PRIVATE_KEY_RESPONSE`. Use the constants
in `src/utils/constants/interfaces.js` rather than adding action strings.

Proof generation has a two-minute attestor budget
(`PROOF_GENERATION_TIMEOUT_MS`). The background response timeout is derived
from that budget with additional headroom. Keep the outer timeout longer than
the attestor timeout so the attestor's error can reach the consumer.

Builder `api=2` requests pass `skipLegacyStatus`. In that mode the offscreen
document still generates the same raw legacy `Proof`; Builder receives the
proof from the background and performs outer-result signing, encryption, and
callback delivery.

## Logging

Use `createRemoteLogger("offscreen")` from `RemoteLogger.js`. Pass structured
values as the `payload` option so the logging hub can redact them at `INFO`.
Never put response bodies, credentials, or proof data in a message string.
