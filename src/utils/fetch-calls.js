import { API_ENDPOINTS, RECLAIM_SESSION_STATUS } from "./constants";

// Note: This file is used by both background and offscreen contexts.
// Logging is handled by the caller to avoid duplicate log instances.

export const fetchProviderData = async (providerId, sessionId, appId) => {
  const response = await fetch(`${API_ENDPOINTS.PROVIDER_URL(providerId)}`);
  if (!response.ok) {
    throw new Error("Failed to fetch provider data");
  }
  const data = await response.json();
  return data?.providers;
};

export const updateSessionStatus = async (sessionId, status, providerId, appId) => {
  const response = await fetch(`${API_ENDPOINTS.UPDATE_SESSION_STATUS()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, status }),
  });

  if (!response.ok) {
    throw new Error("Failed to update session status");
  }

  const res = await response.json();
  return res;
};

export const submitProofOnCallback = async (proofs, submitUrl, sessionId, providerId, appId) => {
  const jsonStringOfProofs = JSON.stringify(proofs);
  const urlEncodedProofs = encodeURIComponent(jsonStringOfProofs);
  const response = await fetch(submitUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: urlEncodedProofs,
  });
  const res = await response.text();
  if (!response.ok) {
    await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_SUBMISSION_FAILED);
    throw new Error("Failed to submit proof to Callback and update session status");
  }

  await updateSessionStatus(sessionId, RECLAIM_SESSION_STATUS.PROOF_SUBMITTED);
  return res;
};
