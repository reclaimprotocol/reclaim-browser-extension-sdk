import { API_ENDPOINTS, RECLAIM_SESSION_STATUS } from "./constants";
import { loggerService, createContextLogger } from "./logger/LoggerService";
import { LOG_TYPES, LOG_LEVEL } from "./logger/constants";

// Default: INFO+ to console and backend
loggerService.setConfig({
  consoleEnabled: true,
  backendEnabled: true,
  consoleLevel: LOG_LEVEL.INFO,
  backendLevel: LOG_LEVEL.INFO,
  includeSensitiveToBackend: false,
  debugMode: false, // set true to print every log to console
});

export const fetchProviderData = async (providerId, sessionId, appId) => {
  const logger = createContextLogger({
    sessionId: sessionId || "unknown",
    providerId: providerId || "unknown",
    appId: appId || "unknown",
    source: "reclaim-extension-sdk",
    type: LOG_TYPES.FETCH_DATA,
  });
  try {
    // PROVIDER_URL
    const response = await fetch(`${API_ENDPOINTS.PROVIDER_URL(providerId)}`);
    // check if response is valid
    if (!response.ok) {
      throw new Error("Failed to fetch provider data");
    }
    logger.info("Successfully fetched provider data from the backend: " + JSON.stringify(response));
    const data = await response.json();
    return data?.providers;
  } catch (error) {
    logger.error("[FETCH-CALLS] Error fetching provider data: " + error.toString());
    throw error;
  }
};

export const updateSessionStatus = async (sessionId, status, providerId, appId) => {
  const logger = createContextLogger({
    sessionId: sessionId || "unknown",
    providerId: providerId || "unknown",
    appId: appId || "unknown",
    source: "reclaim-extension-sdk",
    type: LOG_TYPES.FETCH_DATA,
  });
  try {
    const response = await fetch(`${API_ENDPOINTS.UPDATE_SESSION_STATUS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, status }),
    });

    if (!response.ok) {
      throw new Error("Failed to update session status");
    }
    logger.info("Successfully updated session status: " + status);

    const res = await response.json();
    return res;
  } catch (error) {
    logger.error("Error updating session status: " + error.toString());
    throw error;
  }
};

export const submitProofOnCallback = async (proofs, submitUrl, sessionId, providerId, appId) => {
  const logger = createContextLogger({
    sessionId: sessionId || "unknown",
    providerId: providerId || "unknown",
    appId: appId || "unknown",
    source: "reclaim-extension-sdk",
    type: LOG_TYPES.FETCH_DATA,
  });
  try {
    // 1. Convert the proofs array to a JSON string
    const jsonStringOfProofs = JSON.stringify(proofs);
    // 2. URL-encode the JSON string
    const urlEncodedProofs = encodeURIComponent(jsonStringOfProofs);
    // 3. Append the URL-encoded string to the submit URL
    const response = await fetch(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: urlEncodedProofs, // Send the URL-encoded string as the raw body
    });
    const res = await response.text();
    // check if response is valid
    if (!response.ok) {
      await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_SUBMISSION_FAILED);
      throw new Error("Failed to submit proof to Callback and update session status");
    }
    logger.info("Successfully submitted proof to Callback and updated session status");

    await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_SUBMITTED);
    return res;
  } catch (error) {
    logger.error("[FETCH-CALLS] Error submitting proof to Callback: " + error.toString());
    throw error;
  }
};
