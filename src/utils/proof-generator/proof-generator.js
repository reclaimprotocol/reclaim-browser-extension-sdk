// Import polyfills
import "../polyfills";

import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants/index";
import { ensureOffscreenDocument } from "../offscreen-manager";
import { debugLogger, DebugLogType } from "../logger";

// Main function to generate proof using offscreen document
export const generateProof = async (claimData) => {
  try {
    debugLogger.info(DebugLogType.PROOF, "[PROOF-GENERATOR] Starting proof generation with data:", claimData);
    if (!claimData) {
      throw new Error("No claim data provided for proof generation");
    }
    // Ensure the offscreen document exists and is ready
    await ensureOffscreenDocument();

    // Generate the proof using the offscreen document
    return new Promise((resolve, reject) => {
      const messageTimeout = setTimeout(() => {
        debugLogger.error(DebugLogType.PROOF, "[PROOF-GENERATOR] Timeout waiting for offscreen document to generate proof");
        reject({
          success: false,
          error: "Timeout waiting for offscreen document to generate proof",
        });
      }, 60000); // 60 second timeout

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

          // Check if the proof generation was successful
          if (!response.success) {
            debugLogger.error(DebugLogType.PROOF, "[PROOF-GENERATOR] Proof generation failed:", response.error);
            resolve({
              success: false,
              error: response.error || "Unknown error in proof generation",
            });
            return;
          }

          // Return the successful response
          debugLogger.info(DebugLogType.PROOF, "[PROOF-GENERATOR] Proof generation successful");
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
            debugLogger.error(
              DebugLogType.PROOF,
              "[PROOF-GENERATOR] Error sending message to offscreen document:",
              chrome.runtime.lastError
            );
            reject({
              success: false,
              error: chrome.runtime.lastError.message || "Error communicating with offscreen document",
            });
          }
        }
      );
    });
  } catch (error) {
    debugLogger.error(DebugLogType.PROOF, "[PROOF-GENERATOR] Error in proof generation process:", error);
    return {
      success: false,
      error: error.message || "Unknown error in proof generation process",
    };
  }
};
