// Import necessary utilities and interfaces
import "../utils/polyfills";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES, RECLAIM_SESSION_STATUS } from "../utils/constants";
import { createClaimOnAttestor } from "@reclaimprotocol/attestor-core/browser";
import { WebSocket } from "../utils/offscreen-websocket";
import { updateSessionStatus } from "../utils/fetch-calls";
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
import { EVENT_TYPES } from "../utils/logger/constants";
import { PROOF_GENERATION_TIMEOUT_MS } from "../utils/constants/config";

const logger = createRemoteLogger("offscreen");

// Ensure WebAssembly is available
if (typeof WebAssembly === "undefined") {
  logger.error(
    "[OFFSCREEN] WebAssembly is not available in this browser context",
    "offscreen.init",
    { eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_NOT_READY_EXCEPTION },
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
    logger.info("[OFFSCREEN] Offscreen ready", "offscreen.init", {
      eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_READY,
    });
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
            logger.info("[OFFSCREEN] Generating proof", "offscreen.proof", {
              eventType: EVENT_TYPES.PROOF_GENERATION_STARTED,
            });

            // Captured up front: generateProof() deletes sessionId off the
            // claim data before handing it to the attestor.
            const sessionId = data?.sessionId;

            const proof = await this.generateProof(data?.claimData || data, {
              skipLegacyStatus: data?.skipLegacyStatus === true,
            });

            // Edge case: proof object contains an error
            const embeddedErr =
              proof?.error?.message || (typeof proof?.error === "string" ? proof.error : null);

            if (embeddedErr) {
              logger.error(
                "[OFFSCREEN] Proof contains embedded error: " + embeddedErr,
                "offscreen.proof",
                { eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION },
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

            // Reported here, not on attestor resolution: the proof is only known
            // good once the embedded-error check above has passed.
            try {
              await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS);
            } catch (e) {
              logger.error(
                "[OFFSCREEN] Error updating status to PROOF_GENERATION_SUCCESS: " + e?.message,
                "offscreen.proof",
              );
            }

            chrome.runtime.sendMessage({
              action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
              source: MESSAGE_SOURCES.OFFSCREEN,
              target: MESSAGE_SOURCES.BACKGROUND,
              success: true,
              proof: proof,
            });
          } catch (error) {
            logger.error(
              "[OFFSCREEN] Error generating proof: " + error.message,
              "offscreen.proof",
              { eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION },
            );
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

  async generateProof(claimData, options = {}) {
    if (!claimData) {
      throw new Error("No claim data provided for proof generation");
    }

    const sessionId = claimData.sessionId;
    delete claimData.sessionId;

    // Declared outside the try so the catch can read it — it was set here and
    // never read anywhere, which is why nothing caught the scoping.
    let timeoutOccurred = false;

    try {
      logger.info(
        "[OFFSCREEN] Updating session status to PROOF_GENERATION_STARTED",
        "offscreen.proof",
      );

      if (!options.skipLegacyStatus) {
        await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_STARTED);
      }

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          timeoutOccurred = true;
          reject(
            new Error(
              "Proof generation timed out after " + PROOF_GENERATION_TIMEOUT_MS / 1000 + " seconds",
            ),
          );
        }, PROOF_GENERATION_TIMEOUT_MS);
      });

      // This is the last point the claim is observable before attestor-core gets
      // it: `sessionId` has been stripped above, and it has crossed the
      // chrome-messaging boundary from the background. Logging only the message
      // here left the object that actually reached the attestor invisible, which
      // is the one thing an attestor-side rejection needs. Raw at FINE, redacted
      // at the default INFO — see LoggingHub._addLog.
      logger.debug("[OFFSCREEN] Final claimData for attestor", "offscreen.proof", {
        payload: claimData,
      });

      // NOT awaited here on purpose. Awaiting first and only then racing the
      // timeout meant the race ran against an already-settled value, so
      // PROOF_GENERATION_TIMEOUT_MS could never interrupt a hung attestor call
      // — and the "promise created" line was logged after the call had already
      // finished, landing in the same millisecond as the result and making the
      // logs claim the call started 16s later than it did.
      const attestorPromise = createClaimOnAttestor(claimData);

      logger.info("[OFFSCREEN] Attestor call started", "offscreen.proof");

      const result = await Promise.race([attestorPromise, timeoutPromise]);

      result.publicData = typeof claimData.publicData === "string" ? claimData.publicData : null;

      logger.info("[OFFSCREEN] Attestor promise result received", "offscreen.proof");

      // PROOF_GENERATION_SUCCESS is deliberately NOT reported here. The attestor
      // can resolve with an error carried inside the result object, which only
      // the caller checks. Reporting success on resolution meant a failed
      // session recorded PROOF_GENERATION_SUCCESS and then
      // PROOF_GENERATION_FAILED, so analytics claimed both outcomes for the same
      // session. The caller now reports it once the proof is validated.
      return result;
    } catch (error) {
      // `timeoutOccurred` distinguishes "the attestor took too long" from "the
      // attestor threw", which are different problems with the same message
      // prefix. This is the timeout that actually fires — the background's
      // PROOF_RESPONSE_TIMEOUT_MS is deliberately longer, so it only sees a
      // document that never answered.
      logger.error(
        "[OFFSCREEN] Error generating proof: " + (error?.message || "Unknown error"),
        "offscreen.proof",
        {
          eventType: timeoutOccurred
            ? EVENT_TYPES.CLAIM_CREATION_TIMED_OUT_EXCEPTION
            : EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION,
        },
      );
      if (!options.skipLegacyStatus) {
        await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED);
      }
      throw error;
    }
  }
}

// Initialize the offscreen document
const proofGenerator = new OffscreenProofGenerator();
