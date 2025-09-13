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

export const LOG_SOURCES = {
  BACKGROUND: "background",
  CONTENT: "content",
  OFFSCREEN: "offscreen",
  POPUP: "popup",
  INJECTION: "injection",
};

// Numeric levels for easy threshold checks
export const LOG_LEVEL = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export const DEFAULT_LOG_CONFIG = {
  // Console
  consoleEnabled: true,
  consoleLevel: LOG_LEVEL.INFO, // print INFO+ by default
  includeSensitiveToConsole: true,

  // Backend
  backendEnabled: true,
  backendLevel: LOG_LEVEL.INFO, // send INFO+ by default
  includeSensitiveToBackend: false, // never send sensitive unless enabled

  // Debug mode = print ALL to console; backend still obeys backendLevel
  debugMode: false,

  // Metadata
  source: "reclaim-extension-sdk",
};
