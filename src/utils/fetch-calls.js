import { API_ENDPOINTS, RECLAIM_SESSION_STATUS } from "./constants";
import { withClientSource } from "./logger/client-source";

// Note: This file is used by both background and offscreen contexts.
// Logging is handled by the caller to avoid duplicate log instances.
//
// Every request carries the `reclaim-api-client` header, the same header the
// InApp SDK and Verifier app send, so extension traffic is attributable
// server-side. This is identification only — per the team's guideline the
// extension contributes no device information to analytics, so the request
// bodies are unchanged and `deviceId`/`deviceType` stay absent (the backend
// records them as "NA").

export const fetchProviderData = async (providerId, sessionId, appId) => {
  const response = await fetch(`${API_ENDPOINTS.PROVIDER_URL(providerId)}`, {
    headers: withClientSource(),
  });
  if (!response.ok) {
    throw new Error("Failed to fetch provider data");
  }
  const data = await response.json();
  return data?.providers;
};

export const updateSessionStatus = async (sessionId, status, providerId, appId) => {
  const response = await fetch(`${API_ENDPOINTS.UPDATE_SESSION_STATUS()}`, {
    method: "POST",
    headers: withClientSource({ "Content-Type": "application/json" }),
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
  // NOTE: deliberately no `reclaim-api-client` header here. `submitUrl` is the
  // consumer's own callback endpoint, not a Reclaim API. `Content-Type:
  // text/plain` is CORS-safelisted, so this is currently a "simple" request
  // with no preflight; adding a custom header would force an OPTIONS preflight
  // that arbitrary consumer servers are not required to answer, breaking proof
  // submission. The header also tells the consumer nothing they need.
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
