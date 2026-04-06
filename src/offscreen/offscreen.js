// Import necessary utilities and interfaces
import "../utils/polyfills";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES, RECLAIM_SESSION_STATUS } from "../utils/constants";
import { createClaimOnAttestor } from "@reclaimprotocol/attestor-core";

// Import our specialized WebSocket implementation for offscreen document
import { WebSocket } from "../utils/offscreen-websocket";
import { updateSessionStatus } from "../utils/fetch-calls";
import { createRemoteLogger } from "../utils/logger/RemoteLogger";

const logger = createRemoteLogger("offscreen");

/**
 * Map raw ClaimTunnelResponse to a clean response object.
 * Strips the large TLS transcript data to stay within
 * chrome.runtime.sendMessage 64MB limit.
 * TODO: Remove once attestor-core returns mapped response directly.
 */
function mapToCreateClaimResponse(res) {
  if (!res.claim) {
    const errorMsg = res.error?.message || res.error || "Unknown attestor error";
    throw new Error(errorMsg);
  }

  return {
    claim: res.claim,
    signatures: {
      claimSignature: res.signatures?.claimSignature,
      attestorAddress: res.signatures?.attestorAddress,
    },
  };
}

// Ensure WebAssembly is available
if (typeof WebAssembly === "undefined") {
  logger.error(
    "[OFFSCREEN] WebAssembly is not available in this browser context",
    "offscreen.init",
  );
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
    logger.info("[OFFSCREEN] Offscreen ready", "offscreen.init");
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
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

    if (target !== MESSAGE_SOURCES.OFFSCREEN) return;

    switch (action) {
      case MESSAGE_ACTIONS.PING_OFFSCREEN:
        this.sendReadySignal();
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.GENERATE_PROOF:
        (async () => {
          try {
            logger.info("[OFFSCREEN] Generating proof", "offscreen.proof");

            const proof = await this.generateProof(data);

            // Edge case: proof object contains an error
            const embeddedErr =
              proof?.error?.message || (typeof proof?.error === "string" ? proof.error : null);

            if (embeddedErr) {
              logger.error(
                "[OFFSCREEN] Proof contains embedded error: " + embeddedErr,
                "offscreen.proof",
              );
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
            logger.error("[OFFSCREEN] Error generating proof: " + error.message, "offscreen.proof");
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
          logger.info("[OFFSCREEN] Private key generated", "offscreen.key");
          sendResponse({ success: true, received: true });
        } catch (error) {
          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
            source: MESSAGE_SOURCES.OFFSCREEN,
            target: source,
            success: false,
            error: error.message || "Unknown error generating private key",
          });
          logger.error(
            "[OFFSCREEN] Error generating private key: " + error.message,
            "offscreen.key",
          );
          sendResponse({ success: false, error: error.message });
        }
        break;

      default:
        logger.error("[OFFSCREEN] Unknown action: " + action, "offscreen.message");
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
      logger.info(
        "[OFFSCREEN] Updating session status to PROOF_GENERATION_STARTED",
        "offscreen.proof",
      );

      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_STARTED);

      let timeoutOccurred = false;

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          timeoutOccurred = true;
          reject(new Error("Proof generation timed out after 2 minutes"));
        }, 60000 * 2);
      });

      logger.debug("[OFFSCREEN] Final claimData for attestor", "offscreen.proof");
      const attestorPromise = createClaimOnAttestor(claimData);

      logger.info("[OFFSCREEN] Attestor promise created", "offscreen.proof");

      const rawResult = await Promise.race([
        attestorPromise.catch((err) => {
          console.error("ATTESTOR ERROR ", err);
          throw err;
        }),
        timeoutPromise,
      ]);

      logger.info("[OFFSCREEN] Attestor promise result received", "offscreen.proof");

      // Map raw ClaimTunnelResponse to clean CreateClaimResponse
      // to avoid exceeding chrome.runtime.sendMessage 64MB limit
      const result = mapToCreateClaimResponse(rawResult);
      result.publicData = typeof claimData.publicData === "string" ? claimData.publicData : null;

      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS);
      return result;
    } catch (error) {
      logger.error(
        "[OFFSCREEN] Error generating proof: " + (error?.message || "Unknown error"),
        "offscreen.proof",
      );
      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED);
      throw error;
    }
  }
}

// Initialize the offscreen document
const proofGenerator = new OffscreenProofGenerator();
