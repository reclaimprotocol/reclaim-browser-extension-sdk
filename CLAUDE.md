# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reclaim Protocol Browser Extension SDK - enables websites and browser extensions to trigger Reclaim zero-knowledge proof verification flows. The SDK handles content ↔ background communication, opens provider tabs, generates proofs via an offscreen document (WebAssembly), and emits completion events.

**Chrome Manifest V3 compatible.**

## Build Commands

```bash
# Build for production (outputs to build/)
npm run build

# Format code with Prettier
npm run format

# Copy SDK assets to consumer extension's public folder
npm run reclaim-extension-setup
```

Note: There is no test command configured (`npm test` exits with error). The `prebuild` script runs Prettier automatically.

## Architecture

The SDK follows a multi-context browser extension architecture with three main execution contexts:

### Entry Points

1. **ReclaimExtensionSDK** (`src/ReclaimExtensionSDK.js`) - Main SDK class exported for consumers
   - `reclaimExtensionSDK.init(appId, appSecret, providerId, options)` - Primary API
   - `reclaimExtensionSDK.initializeBackground()` - Must be called in consumer's service worker
   - `reclaimExtensionSDK.fromJsonString(json, options)` - Create from server-generated config
   - Works in both extension context (popup/panel) and web page context (requires `extensionID`)

2. **Background Service** (`src/background/`) - Chrome service worker context
   - `background.js` - Main orchestrator, context initialization
   - `messageRouter.js` - Central message dispatcher
   - `sessionManager.js` - Verification session lifecycle
   - `proofQueue.js` - Sequential proof generation queue
   - `tabManager.js` - Browser tab management
   - `cookieUtils.js` - Cookie extraction for auth

3. **Content Script** (`src/content/`) - Injected into web pages
   - `content.js` - Bridge between web pages/SDK and background
   - Handles network interception coordination
   - Manages verification popup UI

4. **Offscreen Document** (`src/offscreen/`) - Isolated WebAssembly execution
   - Handles zero-knowledge proof generation via `@reclaimprotocol/attestor-core`
   - Private key generation
   - WebSocket connections to Reclaim infrastructure

5. **Network Interceptor** (`src/interceptor/`) - Request/response capture
   - `network-interceptor.js` - Captures network traffic
   - `injection-scripts.js` - Page injection utilities

### Message Flow

```
Web Page/SDK ↔ Content Script ↔ Background Service ↔ Offscreen Document
                    ↓                                        ↓
           Network Interceptor                      Attestor Core (WASM)
```

### Build Output Structure

The webpack config produces three separate builds:

- **extension-classic**: Content script (UMD), interceptor/offscreen (IIFE)
- **background-esm-mv3**: Background + SDK as ES modules (Manifest V3)
- **background-commonjs-mv2**: Background + SDK as CommonJS (Manifest V2/Firefox)

Output bundles in `build/`:

- `ReclaimExtensionSDK.bundle.js` - Main SDK entry
- `background/background.bundle.js` - Service worker
- `content/content.bundle.js` - Content script (must be classic, not ESM)
- `offscreen/offscreen.bundle.js` + `offscreen.html`
- `interceptor/network-interceptor.bundle.js`
- `interceptor/injection-scripts.bundle.js`

## Key Dependencies

- `@reclaimprotocol/attestor-core` - Core proof generation library
- `@reclaimprotocol/tls` - TLS implementation
- `ethers` - Wallet/signature operations for session initialization
- `snarkjs` - Zero-knowledge proof operations (browser excluded via overrides)

## Logging

The SDK includes a logger utility (`src/utils/logger/`) that sends diagnostic logs to Grafana:

```javascript
import { log, logError, loggerService } from "../utils/logger";

log(message, type, sessionId, providerId, appId);
logError(error, type, sessionId, providerId, appId, message);
```

Debug logging uses `debugLogger` with `DebugLogType` constants (BACKGROUND, CONTENT, OFFSCREEN).

## Consumer Integration

Consumers must:

1. Run `npm run reclaim-extension-setup` to copy assets to their public folder
2. Add required manifest entries (CSP, permissions, web_accessible_resources)
3. Call `reclaimExtensionSDK.initializeBackground()` in their service worker
4. Load `content.bundle.js` via manifest or dynamic registration
