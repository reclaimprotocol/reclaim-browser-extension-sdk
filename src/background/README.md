# Background Service Architecture

## Overview

This directory contains a **modular background service architecture** for browser extensions, specifically designed for handling complex verification workflows with external APIs. The architecture is built around a **shared context pattern** with **event-driven messaging** between different modules and browser components.

**Key Features:**

- 🏗️ **Modular Architecture**: Clean separation of concerns across focused modules
- 🔄 **Shared Context Pattern**: Centralized state management with dependency injection
- 📨 **Event-Driven Messaging**: Robust message routing between content scripts, background, and UI
- ⏱️ **Session Management**: Complete lifecycle management with timers and state tracking
- 🍪 **Cookie Handling**: Secure cookie extraction and filtering utilities
- 📊 **Centralized Logging**: Consistent debug logging across all modules
- ⚡ **Async Queue Processing**: Safe sequential processing of proof generation requests

---

## Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Content       │    │   Background    │    │   External      │
│   Scripts       │◄──►│   Service       │◄──►│   APIs          │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                    ┌─────────┼─────────┐
                    │         │         │
            ┌───────▼───┐ ┌───▼───┐ ┌───▼───┐
            │  Session  │ │  Tab  │ │ Proof │
            │ Manager   │ │Manager│ │ Queue │
            └───────────┘ └───────┘ └───────┘
                    │
            ┌───────▼───────┐
            │ Message Router │
            └───────────────┘
```

### Core Components

1. **Context Layer**: Shared state and dependencies
2. **Message Layer**: Event routing and communication
3. **Session Layer**: Verification lifecycle management
4. **Tab Layer**: Browser tab management
5. **Processing Layer**: Async proof generation queue
6. **Utility Layer**: Cookies, logging, and common utilities

---

## File Structure & Responsibilities

### Core Entry Point

#### `background.js` - Main Orchestrator

**Role**: Application bootstrap and event coordination

```javascript
// Context initialization example
const ctx = {
  // State management
  activeTabId: null,
  sessionId: null,
  managedTabs: new Set(),

  // Dependencies
  fetchProviderData,
  generateProof,
  debugLogger,

  // Bound methods
  failSession: (...args) => sessionManager.failSession(ctx, ...args),
  submitProofs: (...args) => sessionManager.submitProofs(ctx, ...args),
};
```

**Key Responsibilities:**

- Context object setup and dependency injection
- Chrome event listener registration
- Module method binding to context
- Session timer configuration

**Integration Points:**

- Import all required modules and utilities
- Bind module methods to shared context
- Register chrome.runtime.onMessage handler
- Setup tab removal and navigation listeners

---

### Message Handling

#### `messageRouter.js` - Central Message Dispatcher

**Role**: Routes incoming messages to appropriate handlers

```javascript
export async function handleMessage(ctx, message, sender, sendResponse) {
  const { action, source, target, data } = message;

  switch (action) {
    case ctx.MESSAGE_ACTIONS.START_VERIFICATION:
      const result = await sessionManager.startVerification(ctx, data);
      sendResponse({ success: true, result });
      break;
    // ... other actions
  }
  return true; // Required for async response
}
```

**Supported Message Actions:**

- `START_VERIFICATION`: Initialize new verification session
- `FILTERED_REQUEST_FOUND`: Process intercepted requests
- `REQUEST_PROVIDER_DATA`: Provide session data to content scripts
- `CLOSE_CURRENT_TAB`: Handle tab cleanup
- `CHECK_IF_MANAGED_TAB`: Verify tab management status

**Integration Guide:**

```javascript
// Adding new message action
case ctx.MESSAGE_ACTIONS.YOUR_NEW_ACTION:
    if (source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT) {
        const result = await yourModule.handleAction(ctx, data);
        sendResponse({ success: true, result });
    }
    break;
```

---

### Session Management

#### `sessionManager.js` - Verification Lifecycle Controller

**Role**: Manages complete verification session lifecycle

```javascript
export async function startVerification(ctx, templateData) {
  // 1. Clear previous session state
  ctx.providerData = null;
  ctx.sessionId = null;
  ctx.generatedProofs = new Map();

  // 2. Fetch provider configuration
  const providerData = await ctx.fetchProviderData(
    templateData.providerId,
    templateData.sessionId,
    templateData.applicationId,
  );

  // 3. Create managed tab
  chrome.tabs.create({ url: providerData.loginUrl }, (tab) => {
    ctx.activeTabId = tab.id;
    ctx.managedTabs.add(tab.id);
  });

  return { success: true, message: "Verification started" };
}
```

**Session States:**

- `SESSION_INIT`: Initial session creation
- `USER_STARTED_VERIFICATION`: User initiated verification
- `PROOF_GENERATION_STARTED`: Proof generation in progress
- `PROOF_GENERATION_SUCCESS`: Proof generated successfully
- `PROOF_SUBMITTED`: Proof submitted to backend

**Key Methods:**

- `startVerification(ctx, templateData)`: Initialize new session
- `failSession(ctx, errorMessage, requestHash)`: Handle session failures
- `submitProofs(ctx)`: Submit generated proofs to backend

---

### Tab Management

**Utilities:**

- `isManagedTab(ctx, tabId)`: Check if tab is managed by extension
- `removeManagedTab(ctx, tabId)`: Remove tab from managed set
- `injectProviderScriptForTab(ctx, tabId)`: No-op function (script injection removed)

---

### Cookie Management

#### `cookieUtils.js` - Cookie Extraction & Filtering

**Role**: Secure cookie handling for authenticated requests

```javascript
export async function getCookiesForUrl(url, debugLogger, DebugLogType) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    const filteredCookies = cookies.filter((cookie) => shouldIncludeCookie(cookie, url));

    return filteredCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch (error) {
    debugLogger.error(DebugLogType.BACKGROUND, "Cookie fetch failed:", error);
    return null;
  }
}
```

**Security Features:**

- Domain validation
- Secure flag checking
- Path matching
- HttpOnly cookie filtering

---

### Async Processing

#### `proofQueue.js` - Sequential Proof Processing

**Role**: Manages proof generation queue to prevent race conditions

```javascript
export function addToProofGenerationQueue(ctx, claimData, requestHash) {
  ctx.proofGenerationQueue.push({ claimData, requestHash });

  if (!ctx.isProcessingQueue) {
    processNextQueueItem(ctx);
  }
}

export async function processNextQueueItem(ctx) {
  if (ctx.proofGenerationQueue.length === 0) {
    ctx.isProcessingQueue = false;
    return;
  }

  ctx.isProcessingQueue = true;
  const { claimData, requestHash } = ctx.proofGenerationQueue.shift();

  try {
    const proof = await ctx.generateProof(claimData);
    ctx.generatedProofs.set(requestHash, proof);

    // Notify content script of success
    chrome.tabs.sendMessage(ctx.activeTabId, {
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_SUCCESS,
      data: { requestHash },
    });
  } catch (error) {
    ctx.failSession(`Proof generation failed: ${error.message}`, requestHash);
  }

  // Process next item
  setTimeout(() => processNextQueueItem(ctx), 100);
}
```

---

### Type Definitions

#### `types.js` - Shared Interfaces

**Role**: TypeScript-ready type definitions (currently minimal, ready for expansion)

```javascript
// Example interface definitions for TypeScript migration
export interface BackgroundContext {
    // State
    activeTabId: number | null;
    sessionId: string | null;
    providerData: ProviderData | null;
    managedTabs: Set<number>;

    // Methods
    failSession: (error: string, requestHash?: string) => Promise<void>;
    submitProofs: () => Promise<void>;
    processFilteredRequest: (request: any, criteria: any, sessionId: string, loginUrl: string) => Promise<any>;
}
```
