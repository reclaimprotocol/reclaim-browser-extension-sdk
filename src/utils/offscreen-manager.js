// src/utils/offscreen-manager.js
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "./constants";

// Lazy import to avoid circular dependency issues at module load time
const getLoggingHub = () => require("./logger/LoggingHub").loggingHub;

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
    getLoggingHub().info(
      "[OFFSCREEN-MANAGER] Received offscreen ready signal (global listener).",
      "offscreen.manager",
    );

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
  getLoggingHub().info(
    "[OFFSCREEN-MANAGER] Attempting to create offscreen document with URL: " + offscreenUrl,
    "offscreen.manager",
  );
  try {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["DOM_PARSER", "IFRAME_SCRIPTING", "BLOBS"],
      justification:
        "Manages DOM-dependent operations like crypto and ZK proof generation for the extension.",
    });
  } catch (error) {
    if (
      error.message &&
      error.message.includes("Only a single offscreen document may be created.")
    ) {
      getLoggingHub().info(
        "[OFFSCREEN-MANAGER] Offscreen document already exists or creation was attempted by another part.",
        "offscreen.manager",
      );
    } else {
      getLoggingHub().error(
        "[OFFSCREEN-MANAGER] Error creating offscreen document: " + error?.message,
        "offscreen.manager",
      );
      throw error;
    }
  }
}

async function waitForOffscreenReadyInternal(timeoutMs = 15000) {
  if (offscreenReady) {
    getLoggingHub().info(
      "[OFFSCREEN-MANAGER] Already ready (waitForOffscreenReadyInternal check)",
      "offscreen.manager",
    );
    return true;
  }

  getLoggingHub().info(
    "[OFFSCREEN-MANAGER] Waiting for offscreen document to be ready (timeout: " +
      timeoutMs +
      "ms)...",
    "offscreen.manager",
  );

  // Proactively ping the offscreen document.
  try {
    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.PING_OFFSCREEN,
      source: MESSAGE_SOURCES.BACKGROUND,
      target: MESSAGE_SOURCES.OFFSCREEN,
    });
  } catch (e) {
    getLoggingHub().info(
      "[OFFSCREEN-MANAGER] Synchronous error sending ping: " + e?.message,
      "offscreen.manager",
    );
  }

  return new Promise((resolve) => {
    if (offscreenReady) {
      getLoggingHub().info(
        "[OFFSCREEN-MANAGER] Became ready while setting up promise.",
        "offscreen.manager",
      );
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
          offscreenDocTimeout = null;
        }
        resolve(true);
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    if (offscreenDocTimeout) {
      clearTimeout(offscreenDocTimeout);
    }
    const localTimeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      getLoggingHub().error(
        "[OFFSCREEN-MANAGER] Timed out waiting for offscreen document after " + timeoutMs + " ms.",
        "offscreen.manager",
      );

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
    logger.info("[OFFSCREEN-MANAGER] Document already confirmed ready.", "offscreen.manager");
    return true;
  }

  // If a creation process is already underway, await its completion.
  if (offscreenCreationPromise) {
    logger.info(
      "[OFFSCREEN-MANAGER] Creation already in progress, awaiting...",
      "offscreen.manager",
    );
    await offscreenCreationPromise;
  }

  // Check if an offscreen document context already exists.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length > 0) {
      logger.info("[OFFSCREEN-MANAGER] Offscreen document context found.", "offscreen.manager");
      if (offscreenReady) return true;
      logger.info(
        "[OFFSCREEN-MANAGER] Context exists, but not marked ready. Waiting for signal...",
        "offscreen.manager",
      );

      return await waitForOffscreenReadyInternal(5000);
    }
  }

  // If no context found and not ready, and no creation in progress, attempt to create.
  if (!offscreenCreationPromise) {
    logger.info(
      "[OFFSCREEN-MANAGER] No existing context/promise, initiating creation.",
      "offscreen.manager",
    );
    offscreenCreationPromise = createOffscreenDocumentInternal().finally(() => {
      offscreenCreationPromise = null;
    });
    await offscreenCreationPromise;
  }

  // After ensuring creation was attempted (or awaited), wait for it to become ready.
  const isReady = await waitForOffscreenReadyInternal(50000);
  if (!isReady) {
    throw new Error("Failed to initialize or confirm offscreen document readiness.");
  }
  logger.info("[OFFSCREEN-MANAGER] Offscreen document ensured to be ready.", "offscreen.manager");
  return true;
}
