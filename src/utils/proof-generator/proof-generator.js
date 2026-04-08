// Import polyfills
import "../polyfills";

import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants/index";
import { ensureOffscreenDocument } from "../offscreen-manager";
import { PROOF_RESPONSE_TIMEOUT_MS } from "../constants/config";

// Main function to generate proof using offscreen document
export const generateProof = async (claimData, loggingHub) => {
  try {
    if (!claimData) {
      loggingHub.error(
        "[PROOF-GENERATOR] No claim data provided for proof generation",
        "proof.generation",
      );
      throw new Error("No claim data provided for proof generation");
    }
    // Ensure the offscreen document exists and is ready
    await ensureOffscreenDocument(loggingHub);

    // Generate the proof using the offscreen document
    return new Promise((resolve, reject) => {
      const messageTimeout = setTimeout(() => {
        loggingHub.error(
          "[PROOF-GENERATOR] Timeout waiting for offscreen document to generate proof",
          "proof.generation",
        );
        reject({
          success: false,
          error: "Timeout waiting for offscreen document to generate proof",
        });
      }, PROOF_RESPONSE_TIMEOUT_MS);

      // Create a message listener for the offscreen response
      const messageListener = (response) => {
        if (
          response.action === MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE &&
          response.source === MESSAGE_SOURCES.OFFSCREEN &&
          response.target === MESSAGE_SOURCES.BACKGROUND
        ) {
          // Clear timeout and remove listener
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

      // Add listener for response
      chrome.runtime.onMessage.addListener(messageListener);

      // Send message to offscreen document to generate proof
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
            loggingHub.error(
              "[PROOF-GENERATOR] Error sending message to offscreen document: " +
                chrome.runtime.lastError.message,
              "proof.generation",
            );
            reject({
              success: false,
              error:
                chrome.runtime.lastError.message || "Error communicating with offscreen document",
            });
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
