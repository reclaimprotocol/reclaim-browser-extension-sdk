// Import necessary utilities and interfaces
import "../utils/polyfills";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES, RECLAIM_SESSION_STATUS } from "../utils/constants";
import { createClaimOnAttestor } from "@reclaimprotocol/attestor-core";
// Import our specialized WebSocket implementation for offscreen document
import { WebSocket } from "../utils/offscreen-websocket";
import { updateSessionStatus } from "../utils/fetch-calls";
import { debugLogger, DebugLogType } from "../utils/logger";

console.log({ chrome }, "Offscreen chrome");

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

console.log({ window });

class OffscreenProofGenerator {
  constructor() {
    this.init();
  }

  init() {
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    this.sendReadySignal();
  }

  sendReadySignal() {
    console.log("Sending ready signal");
    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY,
      source: MESSAGE_SOURCES.OFFSCREEN,
      target: MESSAGE_SOURCES.BACKGROUND,
    });
  }

  handleMessage(message, sender, sendResponse) {
    const { action, source, target, data } = message;

    console.log({ message, sender, sendResponse }, "Offscreen handleMessage message received");

    if (target !== MESSAGE_SOURCES.OFFSCREEN) return;

    switch (action) {
      case MESSAGE_ACTIONS.PING_OFFSCREEN:
        this.sendReadySignal();
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.GENERATE_PROOF:
        (async () => {
          try {
            const proof = await this.generateProof(data);
            chrome.runtime.sendMessage({
              action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
              source: MESSAGE_SOURCES.OFFSCREEN,
              target: MESSAGE_SOURCES.BACKGROUND,
              success: true,
              proof: proof,
            });
          } catch (error) {
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
          sendResponse({ success: true, received: true });
        } catch (error) {
          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
            source: MESSAGE_SOURCES.OFFSCREEN,
            target: source,
            success: false,
            error: error.message || "Unknown error generating private key",
          });
          sendResponse({ success: false, error: error.message });
        }
        break;

      default:
        sendResponse({ success: false, error: "Unknown action" });
    }

    return true;
  }

  async generateProof(claimData) {
    if (!claimData) {
      throw new Error("No claim data provided for proof generation");
    }

    const sessionId = claimData.sessionId;
    delete claimData.sessionId;

    try {
      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_STARTED);

      let timeoutOccurred = false;

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          timeoutOccurred = true;
          reject(new Error("Proof generation timed out after 1 minute"));
        }, 60000);
      });

      const attestorPromise = createClaimOnAttestor(claimData);
      const result = await Promise.race([attestorPromise, timeoutPromise]);

      result.publicData = typeof claimData.publicData === "string" ? claimData.publicData : null;

      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS);
      return result;
    } catch (error) {
      console.log({ error }, "Offscreen error");
      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED);
      throw error;
    }
  }
}

// Initialize the offscreen document
const proofGenerator = new OffscreenProofGenerator();
console.log({ proofGenerator }, "Offscreen proofGenerator initialized");
