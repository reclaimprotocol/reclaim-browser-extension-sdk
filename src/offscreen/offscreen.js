// Import necessary utilities and interfaces
import "../utils/polyfills";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES, RECLAIM_SESSION_STATUS } from "../utils/constants";
import { createClaimOnAttestor } from "@reclaimprotocol/attestor-core";
// Import our specialized WebSocket implementation for offscreen document
import { WebSocket } from "../utils/offscreen-websocket";
import { updateSessionStatus } from "../utils/fetch-calls";
import { debugLogger, DebugLogType } from "../utils/logger";
import { loggerService, createContextLogger } from "../utils/logger/LoggerService";
import { EVENT_TYPES, LOG_LEVEL, LOG_TYPES } from "../utils/logger/constants";

const offscreenLogger = createContextLogger({
  sessionId: "unknown",
  providerId: "unknown",
  appId: "unknown",
  source: "reclaim-extension-sdk",
  type: LOG_TYPES.OFFSCREEN,
});

// Ensure WebAssembly is available
if (typeof WebAssembly === "undefined") {
  debugLogger.error(DebugLogType.OFFSCREEN, "WebAssembly is not available in this browser context");
}

// Set WASM path to the extension's public path
if (typeof global !== "undefined") {
  global.WASM_PATH = chrome.runtime.getURL("");
}

// Set appropriate COOP/COEP headers for SharedArrayBuffer support
const metaCSP = document.createElement("meta");
metaCSP.httpEquiv = "Cross-Origin-Embedder-Policy";
metaCSP.content = "require-corp";
document.head.appendChild(metaCSP);

const metaCOOP = document.createElement("meta");
metaCOOP.httpEquiv = "Cross-Origin-Opener-Policy";
metaCOOP.content = "same-origin";
document.head.appendChild(metaCOOP);

// Ensure WebSocket is globally available in the offscreen context
window.WebSocket = WebSocket;

class OffscreenProofGenerator {
  constructor() {
    this.init();
  }

  init() {
    offscreenLogger.info({
      message: "[OFFSCREEN] Offscreen ready",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.OFFSCREEN,
    });
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));

    // Load and live-sync log config
    try {
      const { LOG_CONFIG_STORAGE_KEY } = require("../utils/logger/constants");
      chrome.storage.local.get([LOG_CONFIG_STORAGE_KEY], (res) => {
        const cfg = res?.[LOG_CONFIG_STORAGE_KEY];
        if (cfg && typeof cfg === "object") loggerService.setConfig(cfg);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[LOG_CONFIG_STORAGE_KEY]) {
          const newCfg = changes[LOG_CONFIG_STORAGE_KEY].newValue || {};
          loggerService.setConfig(newCfg);
        }
      });
    } catch {}

    this.sendReadySignal();
  }

  sendReadySignal() {
    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY,
      source: MESSAGE_SOURCES.OFFSCREEN,
      target: MESSAGE_SOURCES.BACKGROUND,
    });
  }

  handleMessage(message, sender, sendResponse) {
    const { action, source, target, data, sessionId, providerId } = message;

    if (sessionId && providerId && sessionId !== "unknown" && providerId !== "unknown") {
      offscreenLogger.setContext({
        sessionId: sessionId,
        providerId: providerId,
        type: LOG_TYPES.OFFSCREEN,
      });
    }

    if (target !== MESSAGE_SOURCES.OFFSCREEN) return;

    switch (action) {
      case MESSAGE_ACTIONS.PING_OFFSCREEN:
        this.sendReadySignal();
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.GENERATE_PROOF:
        (async () => {
          try {
            offscreenLogger.info({
              message: "[OFFSCREEN] Generating proof",
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.OFFSCREEN,
              eventType: EVENT_TYPES.PROOF_GENERATION_STARTED,
            });

            const proof = await this.generateProof(data, offscreenLogger);

            // Edge case: proof object contains an error
            const embeddedErr =
              proof?.error?.message || (typeof proof?.error === "string" ? proof.error : null);

            if (embeddedErr) {
              offscreenLogger.error({
                message: "[OFFSCREEN] Proof contains embedded error:",
                logLevel: LOG_LEVEL.ERROR,
                type: LOG_TYPES.OFFSCREEN,
                eventType: EVENT_TYPES.PROOF_GENERATION_FAILED,
              });
              chrome.runtime.sendMessage({
                action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
                source: MESSAGE_SOURCES.OFFSCREEN,
                target: MESSAGE_SOURCES.BACKGROUND,
                success: false,
                error: embeddedErr,
              });
              return;
            }

            chrome.runtime.sendMessage({
              action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
              source: MESSAGE_SOURCES.OFFSCREEN,
              target: MESSAGE_SOURCES.BACKGROUND,
              success: true,
              proof: proof,
            });
          } catch (error) {
            offscreenLogger.error({
              message: "[OFFSCREEN] Error generating proof: " + error.message,
              logLevel: LOG_LEVEL.ERROR,
              type: LOG_TYPES.OFFSCREEN,
              eventType: EVENT_TYPES.PROOF_GENERATION_FAILED,
            });
            chrome.runtime.sendMessage({
              action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
              source: MESSAGE_SOURCES.OFFSCREEN,
              target: MESSAGE_SOURCES.BACKGROUND,
              success: false,
              error: error.message || "Unknown error in proof generation",
            });
          }
        })();

        sendResponse({ received: true });
        break;

      case MESSAGE_ACTIONS.GET_PRIVATE_KEY:
        try {
          const randomBytes = window.crypto.getRandomValues(new Uint8Array(32));
          const privateKey =
            "0x" +
            Array.from(randomBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");

          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
            source: MESSAGE_SOURCES.OFFSCREEN,
            target: source,
            success: true,
            privateKey: privateKey,
          });
          offscreenLogger.info({
            message: "[OFFSCREEN] Private key generated",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.OFFSCREEN,
          });
          sendResponse({ success: true, received: true });
        } catch (error) {
          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
            source: MESSAGE_SOURCES.OFFSCREEN,
            target: source,
            success: false,
            error: error.message || "Unknown error generating private key",
          });
          offscreenLogger.error({
            message: "[OFFSCREEN] Error generating private key: " + error.message,
            logLevel: LOG_LEVEL.ERROR,
            type: LOG_TYPES.OFFSCREEN,
          });
          sendResponse({ success: false, error: error.message });
        }
        break;

      default:
        offscreenLogger.error({
          message: "[OFFSCREEN] Unknown action: " + action,
          logLevel: LOG_LEVEL.ERROR,
          type: LOG_TYPES.OFFSCREEN,
        });
        sendResponse({ success: false, error: "Unknown action" });
    }

    return true;
  }

  async generateProof(claimData, offscreenLogger) {
    if (!claimData) {
      throw new Error("No claim data provided for proof generation");
    }

    const sessionId = claimData.sessionId;
    delete claimData.sessionId;

    try {
      offscreenLogger.info({
        message: "[OFFSCREEN] Updating session status to PROOF_GENERATION_STARTED",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.OFFSCREEN,
        eventType: EVENT_TYPES.PROOF_GENERATION_STARTED,
      });

      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_STARTED);

      let timeoutOccurred = false;

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          timeoutOccurred = true;
          reject(new Error("Proof generation timed out after 2 minutes"));
        }, 60000 * 2);
      });

      const attestorPromise = await createClaimOnAttestor(claimData);

      offscreenLogger.info({
        message: "[OFFSCREEN] Attestor promise created",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.OFFSCREEN,
        eventType: EVENT_TYPES.PROOF_GENERATION_SUCCESS,
      });

      const result = await Promise.race([attestorPromise, timeoutPromise]);

      result.publicData = typeof claimData.publicData === "string" ? claimData.publicData : null;

      offscreenLogger.info({
        message: "[OFFSCREEN] Attestor promise result: " + JSON.stringify(result),
        logLevel: LOG_LEVEL.ALL,
        type: LOG_TYPES.OFFSCREEN,
        eventType: EVENT_TYPES.RESULT_RECEIVED,
        meta: { result },
      });

      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS);
      return result;
    } catch (error) {
      offscreenLogger.error({
        message: "[OFFSCREEN] Error generating proof: " + error?.message || "Unknown error",
        logLevel: LOG_LEVEL.ERROR,
        type: LOG_TYPES.OFFSCREEN,
        eventType: EVENT_TYPES.PROOF_GENERATION_FAILED,
      });
      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED);
      throw error;
    }
  }
}

// Initialize the offscreen document
const proofGenerator = new OffscreenProofGenerator();
