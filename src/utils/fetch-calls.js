import { API_ENDPOINTS, RECLAIM_SESSION_STATUS } from "./constants";
import { createContextLogger } from "./logger/LoggerService";
import { EVENT_TYPES, LOG_LEVEL, LOG_TYPES } from "./logger/constants";

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
    logger.info({
      message: "Successfully fetched provider data from the backend: " + JSON.stringify(response),
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.FETCH_DATA,
    });
    const data = await response.json();
    return data?.providers;
  } catch (error) {
    logger.error({
      message: "Error fetching provider data: " + error.toString(),
      logLevel: LOG_LEVEL.ERROR,
      type: LOG_TYPES.FETCH_DATA,
      eventType: EVENT_TYPES.RECLAIM_PROVIDER_DATA_FETCH_ERROR,
    });
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

    logger.info({
      message: "Successfully updated session status: " + status,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.FETCH_DATA,
    });

    const res = await response.json();
    return res;
  } catch (error) {
    logger.error({
      message: "Error updating session status: " + error.toString(),
      logLevel: LOG_LEVEL.ERROR,
      type: LOG_TYPES.FETCH_DATA,
      eventType: EVENT_TYPES.UPDATE_SESSION_STATUS_ERROR,
    });
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
    logger.info({
      message: "Successfully submitted proof to Callback and updated session status",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.FETCH_DATA,
      eventType: EVENT_TYPES.SUBMITTING_PROOF_TO_CALLBACK_URL_SUCCESS,
    });

    await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_SUBMITTED);
    return res;
  } catch (error) {
    logger.error({
      message: "Error submitting proof to Callback: " + error.toString(),
      logLevel: LOG_LEVEL.ERROR,
      type: LOG_TYPES.FETCH_DATA,
    });
    throw error;
  }
};
