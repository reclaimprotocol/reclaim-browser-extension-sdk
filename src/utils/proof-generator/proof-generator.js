import "../polyfills";

import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants/index";
import { ensureOffscreenDocument } from "../offscreen-manager";
import { PROOF_RESPONSE_TIMEOUT_MS } from "../constants/config";
import { EVENT_TYPES } from "../logger/constants";

/**
 * Reject with a real Error that still carries the `{success, error}` shape.
 *
 * These paths used to reject a plain object literal, so `error.message` in
 * proofQueue's catch was `undefined` — the session's one explanation of a proof
 * timeout read "Proof generation failed: undefined", and that string is also
 * what reaches the consumer's Promise.
 */
const rejection = (message) => {
  const error = new Error(message);
  error.success = false;
  error.error = message;
  return error;
};

export const generateProof = async (claimData, loggingHub) => {
  try {
    if (!claimData) {
      loggingHub.error(
        "[PROOF-GENERATOR] No claim data provided for proof generation",
        "proof.generation",
      );
      throw new Error("No claim data provided for proof generation");
    }
    await ensureOffscreenDocument(loggingHub);

    // Generate the proof using the offscreen document
    return new Promise((resolve, reject) => {
      const messageTimeout = setTimeout(() => {
        // Reaching this means the offscreen document never answered at all —
        // its own PROOF_GENERATION_TIMEOUT_MS is shorter and would have replied
        // with a more specific error first. Say so, rather than reporting it as
        // a generic proof timeout.
        const message =
          "Offscreen document did not respond within " +
          PROOF_RESPONSE_TIMEOUT_MS / 1000 +
          "s (it should have reported its own timeout first — the document is likely gone)";
        loggingHub.error("[PROOF-GENERATOR] " + message, "proof.generation", {
          eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION,
        });
        reject(rejection(message));
      }, PROOF_RESPONSE_TIMEOUT_MS);

      const messageListener = (response) => {
        if (
          response.action === MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE &&
          response.source === MESSAGE_SOURCES.OFFSCREEN &&
          response.target === MESSAGE_SOURCES.BACKGROUND
        ) {
          clearTimeout(messageTimeout);
          chrome.runtime.onMessage.removeListener(messageListener);

          loggingHub.debug(
            "[PROOF-GENERATOR] Offscreen response: " + JSON.stringify(response),
            "proof.generation",
          );

          // Check if the proof generation was successful
          if (!response.success) {
            loggingHub.error(
              "[PROOF-GENERATOR] Proof generation failed: " + response.error,
              "proof.generation",
            );
            resolve({
              success: false,
              error: response.error || "Unknown error in proof generation",
            });
            return;
          }

          // Edge case: success=true but proof contains an error
          const embeddedErr =
            response?.proof?.error?.message ||
            (typeof response?.proof?.error === "string" ? response.proof.error : null);
          if (embeddedErr) {
            loggingHub.error(
              "[PROOF-GENERATOR] Proof contains embedded error: " + embeddedErr,
              "proof.generation",
            );
            resolve({ success: false, error: embeddedErr });
            return;
          }
          // Return the successful response
          loggingHub.info("[PROOF-GENERATOR] Proof generation successful", "proof.generation");
          resolve(response);
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.GENERATE_PROOF,
          source: MESSAGE_SOURCES.BACKGROUND,
          target: MESSAGE_SOURCES.OFFSCREEN,
          data: claimData,
        },
        () => {
          if (chrome.runtime.lastError) {
            clearTimeout(messageTimeout);
            chrome.runtime.onMessage.removeListener(messageListener);
            const message =
              chrome.runtime.lastError.message || "Error communicating with offscreen document";
            loggingHub.error(
              "[PROOF-GENERATOR] Error sending message to offscreen document: " + message,
              "proof.generation",
              { eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION },
            );
            reject(rejection(message));
          }
        },
      );
    });
  } catch (error) {
    loggingHub.error(
      "[PROOF-GENERATOR] Error in proof generation process: " + error.message,
      "proof.generation",
    );
    return {
      success: false,
      error: error.message || "Unknown error in proof generation process",
    };
  }
};
