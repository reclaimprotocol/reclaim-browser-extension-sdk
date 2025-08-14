export const LOGGING_ENDPOINTS = {
  DIAGNOSTIC_LOGGING: "https://logs.reclaimprotocol.org/api/business-logs/logDump",
};

export const LOG_TYPES = {
  BACKGROUND: "reclaim_browser_extension.BackgroundProcess",
  CONTENT: "reclaim_browser_extension.ContentScript",
  POPUP: "reclaim_browser_extension.Popup",
  INIT: "reclaim_browser_extension.Initialization",
  VERIFICATION: "reclaim_browser_extension.Verification",
  FETCH_DATA: "reclaim_browser_extension.FetchData",
  PROVIDER_DATA: "reclaim_browser_extension.ProviderData",
  CLAIM_CREATION: "reclaim_browser_extension.ClaimCreation",
  PROOF_GENERATION: "reclaim_browser_extension.ProofGeneration",
  PROOF_SUBMISSION: "reclaim_browser_extension.ProofSubmission",
  PROOF_VERIFICATION: "reclaim_browser_extension.ProofVerification",
  OFFSCREEN: "reclaim_browser_extension.Offscreen",
};
