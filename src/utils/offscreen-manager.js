// src/utils/offscreen-manager.js
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "./constants";
import { createContextLogger } from "./logger/LoggerService";
import { LOG_LEVEL, LOG_TYPES } from "./logger/constants";

const offscreenLogger = createContextLogger({
  sessionId: "unknown",
  providerId: "unknown",
  appId: "unknown",
  source: "reclaim-extension-sdk",
  type: LOG_TYPES.OFFSCREEN,
});

// Track the offscreen document status
let offscreenReady = false;
let offscreenDocTimeout = null; // Used by waitForOffscreenReady's timeout
let offscreenCreationPromise = null;

// Define the global listener first
const offscreenGlobalListener = (message) => {
  if (
    message?.action === MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY &&
    message?.source === MESSAGE_SOURCES.OFFSCREEN &&
    message?.target === MESSAGE_SOURCES.BACKGROUND
  ) {
    offscreenLogger.info({
      message: "[OFFSCREEN-MANAGER] Received offscreen ready signal (global listener).",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
    });

    offscreenReady = true;
    if (offscreenDocTimeout) {
      clearTimeout(offscreenDocTimeout);
      offscreenDocTimeout = null;
    }
  }
};

// Exported installer to attach the listener safely in SW context
export const installOffscreenReadyListener = () => {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    !chrome.runtime.onMessage ||
    !chrome.runtime.onMessage.addListener ||
    !chrome.runtime.onMessage.hasListener
  ) {
    return;
  }
  if (chrome.runtime.onMessage.hasListener(offscreenGlobalListener)) {
    return;
  }
  chrome.runtime.onMessage.addListener(offscreenGlobalListener);
};

// Global listener for the ready signal from offscreen document.
// This needs to be set up immediately to catch the ready signal if the offscreen document
// initializes and sends it before any call to ensureOffscreenDocument.
const setupOffscreenReadyListener = () => {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    !chrome.runtime.onMessage ||
    !chrome.runtime.onMessage.addListener ||
    !chrome.runtime.onMessage.hasListener
  ) {
    return;
  }
  if (chrome.runtime.onMessage.hasListener(offscreenGlobalListener)) {
    return;
  }
  chrome.runtime.onMessage.addListener(offscreenGlobalListener);
};

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  setupOffscreenReadyListener();
}

// Set up listener immediately when the module loads
setupOffscreenReadyListener();

async function createOffscreenDocumentInternal() {
  const offscreenUrl = chrome.runtime.getURL(
    "reclaim-browser-extension-sdk/offscreen/offscreen.html",
  );
  offscreenLogger.info({
    message: "[OFFSCREEN-MANAGER] Attempting to create offscreen document with URL:",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.OFFSCREEN,
    meta: { offscreenUrl },
  });
  try {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["DOM_PARSER", "IFRAME_SCRIPTING", "BLOBS"], // Added BLOBS for crypto if needed
      justification:
        "Manages DOM-dependent operations like crypto and ZK proof generation for the extension.",
    });
  } catch (error) {
    if (
      error.message &&
      error.message.includes("Only a single offscreen document may be created.")
    ) {
      offscreenLogger.info({
        message:
          "[OFFSCREEN-MANAGER] Offscreen document already exists or creation was attempted by another part.",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.OFFSCREEN,
      });
      // It exists, so we just need to wait for it to be ready if it's not already.
      // The ensureOffscreenDocument logic will handle waiting for readiness.
    } else {
      offscreenLogger.error({
        message: "[OFFSCREEN-MANAGER] Error creating offscreen document:",
        logLevel: LOG_LEVEL.ERROR,
        type: LOG_TYPES.OFFSCREEN,
        meta: { error },
      });
      throw error; // Re-throw other errors
    }
  }
}

async function waitForOffscreenReadyInternal(timeoutMs = 15000) {
  if (offscreenReady) {
    offscreenLogger.info({
      message: "[OFFSCREEN-MANAGER] Already ready (waitForOffscreenReadyInternal check)",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
    });
    return true;
  }

  offscreenLogger.info({
    message:
      "[OFFSCREEN-MANAGER] Waiting for offscreen document to be ready (timeout:- ${timeoutMs}ms)...",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.OFFSCREEN,
    meta: { timeoutMs },
  });

  // Proactively ping the offscreen document.
  // This can help if the offscreen document is already running but this manager missed the initial ready signal.
  try {
    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.PING_OFFSCREEN,
      source: MESSAGE_SOURCES.BACKGROUND,
      target: MESSAGE_SOURCES.OFFSCREEN,
    });
  } catch (e) {
    offscreenLogger.info({
      message: "[OFFSCREEN-MANAGER] Synchronous error sending ping:" + e?.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
      meta: { error: e },
    });
  }

  return new Promise((resolve) => {
    if (offscreenReady) {
      // Double check after setup
      offscreenLogger.info({
        message: "[OFFSCREEN-MANAGER] Became ready while setting up promise.",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.OFFSCREEN,
      });
      resolve(true);
      return;
    }

    const listener = (message) => {
      if (
        message.action === MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY &&
        message.source === MESSAGE_SOURCES.OFFSCREEN &&
        message.target === MESSAGE_SOURCES.BACKGROUND
      ) {
        offscreenReady = true;
        clearTimeout(localTimeoutId);
        chrome.runtime.onMessage.removeListener(listener);
        if (offscreenDocTimeout === localTimeoutId) {
          // Clear global timeout if it's this one
          offscreenDocTimeout = null;
        }
        resolve(true);
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    // Clear any previous timeout and set a new one for this wait
    if (offscreenDocTimeout) {
      clearTimeout(offscreenDocTimeout);
    }
    const localTimeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      offscreenLogger.error({
        message:
          "[OFFSCREEN-MANAGER] Timed out waiting for offscreen document after " +
          timeoutMs +
          " ms.",
        logLevel: LOG_LEVEL.ERROR,
        type: LOG_TYPES.OFFSCREEN,
        meta: { timeoutMs },
      });

      if (offscreenDocTimeout === localTimeoutId) {
        offscreenDocTimeout = null;
      }
      resolve(false);
    }, timeoutMs);
    offscreenDocTimeout = localTimeoutId;
  });
}

export async function ensureOffscreenDocument(logger) {
  if (offscreenReady) {
    logger.info({
      message: "[OFFSCREEN-MANAGER] Document already confirmed ready.",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
    });
    return true;
  }

  // If a creation process is already underway, await its completion.
  if (offscreenCreationPromise) {
    logger.info({
      message: "[OFFSCREEN-MANAGER] Creation already in progress, awaiting...",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
    });
    await offscreenCreationPromise;
    // After creation promise resolves, it might still not be "ready" (message might be pending)
    // Fall through to waitForOffscreenReadyInternal
  }

  // Check if an offscreen document context already exists.
  // This is useful if the service worker restarted but the offscreen document persisted.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length > 0) {
      logger.info({
        message: "[OFFSCREEN-MANAGER] Offscreen document context found.",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.OFFSCREEN,
      });
      if (offscreenReady) return true; // Already marked ready by global listener
      // If context exists but not marked ready, wait for the signal
      logger.info({
        message: "[OFFSCREEN-MANAGER] Context exists, but not marked ready. Waiting for signal...",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.OFFSCREEN,
      });

      return await waitForOffscreenReadyInternal(5000); // Shorter timeout if context found
    }
  }

  // If no context found and not ready, and no creation in progress, attempt to create.
  if (!offscreenCreationPromise) {
    logger.info({
      message: "[OFFSCREEN-MANAGER] No existing context/promise, initiating creation.",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
    });
    offscreenCreationPromise = createOffscreenDocumentInternal().finally(() => {
      offscreenCreationPromise = null; // Clear promise once operation (success or fail) is done
    });
    await offscreenCreationPromise;
  }

  // After ensuring creation was attempted (or awaited), wait for it to become ready.
  const isReady = await waitForOffscreenReadyInternal(50000);
  if (!isReady) {
    throw new Error("Failed to initialize or confirm offscreen document readiness.");
  }
  logger.info({
    message: "[OFFSCREEN-MANAGER] Offscreen document ensured to be ready.",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.OFFSCREEN,
  });
  return true;
}
