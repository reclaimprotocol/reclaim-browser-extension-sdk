import { API_ENDPOINTS, RECLAIM_SESSION_STATUS } from "./constants";
import { loggerService, LOG_TYPES, debugLogger, DebugLogType } from "./logger";

export const fetchProviderData = async (providerId, sessionId, appId) => {
  try {
    // PROVIDER_URL
    const response = await fetch(`${API_ENDPOINTS.PROVIDER_URL(providerId)}`);
    // check if response is valid
    if (!response.ok) {
      throw new Error("Failed to fetch provider data");
    }
    loggerService.log({
      message: "Successfully fetched provider data from the backend: " + JSON.stringify(response),
      type: LOG_TYPES.FETCH_DATA,
      sessionId,
      providerId,
      appId,
    });
    const data = await response.json();
    return data?.providers;
  } catch (error) {
    loggerService.logError({
      error: "Error fetching provider data: " + error.toString(),
      type: LOG_TYPES.FETCH_DATA,
      sessionId,
      providerId,
      appId,
    });
    debugLogger.error(DebugLogType.FETCH, "Error fetching provider data:", error);
    throw error;
  }
};

export const updateSessionStatus = async (sessionId, status, providerId, appId) => {
  try {
    const response = await fetch(`${API_ENDPOINTS.UPDATE_SESSION_STATUS()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, status }),
    });

    if (!response.ok) {
      throw new Error("Failed to update session status");
    }
    loggerService.log({
      message: "Successfully updated session status: " + status,
      type: LOG_TYPES.FETCH_DATA,
      sessionId,
      providerId,
      appId,
    });

    const res = await response.json();
    return res;
  } catch (error) {
    loggerService.logError({
      error: "Error updating session status: " + error.toString(),
      type: LOG_TYPES.FETCH_DATA,
      sessionId,
      providerId,
      appId,
    });
    throw error;
  }
};

export const submitProofOnCallback = async (proofs, submitUrl, sessionId, providerId, appId) => {
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
    loggerService.log({
      message: "Successfully submitted proof to Callback and updated session status",
      type: LOG_TYPES.FETCH_DATA,
      sessionId,
      providerId,
      appId,
    });
    await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_SUBMITTED);
    return res;
  } catch (error) {
    loggerService.logError({
      error: "Error submitting proof to Callback: " + error.toString(),
      type: LOG_TYPES.FETCH_DATA,
      sessionId,
      providerId,
      appId,
    });
    debugLogger.error(DebugLogType.FETCH, "Error submitting proof to Callback:", error);
    throw error;
  }
};
