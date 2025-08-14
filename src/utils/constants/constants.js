export const BACKEND_URL = "https://api.reclaimprotocol.org";

export const API_ENDPOINTS = {
  PROVIDER_URL: (providerId) => `${BACKEND_URL}/api/providers/${providerId}`,
  SUBMIT_PROOF: (sessionId) => `${BACKEND_URL}/session/${sessionId}/proof`,
  UPDATE_SESSION_STATUS: () => `${BACKEND_URL}/api/sdk/update/session/`,
  STATUS_URL: (sessionId) => `${BACKEND_URL}/api/sdk/status/${sessionId}`, // added
};
