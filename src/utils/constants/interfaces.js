/**
 * @typedef {Object} TemplateData
 * @property {string} sessionId - Unique identifier for the session
 * @property {string} providerId - Provider identifier
 * @property {string} applicationId - Application identifier
 * @property {string} signature - Signature for authentication
 * @property {string} timestamp - Timestamp of the request
 * @property {string} callbackUrl - URL to call back after verification
 * @property {string} context - Context data as JSON string
 * @property {Object} parameters - Additional parameters
 * @property {string} redirectUrl - URL to redirect after completion
 * @property {boolean} acceptAiProviders - Whether to accept AI providers
 * @property {string} sdkVersion - SDK version
 * @property {boolean} jsonProofResponse - Whether to return proof as JSON
 */

export const RECLAIM_SDK_ACTIONS = {
  CHECK_EXTENSION: "RECLAIM_EXTENSION_CHECK",
  EXTENSION_RESPONSE: "RECLAIM_EXTENSION_RESPONSE",
  START_VERIFICATION: "RECLAIM_START_VERIFICATION",
  VERIFICATION_STARTED: "RECLAIM_VERIFICATION_STARTED",
  VERIFICATION_COMPLETED: "RECLAIM_VERIFICATION_COMPLETED",
  VERIFICATION_FAILED: "RECLAIM_VERIFICATION_FAILED",
  CANCEL_VERIFICATION: "RECLAIM_CANCEL_VERIFICATION",
  SET_PUBLIC_DATA: "RECLAIM_SET_PUBLIC_DATA",
  PARAMETERS_UPDATE: "RECLAIM_PARAMETERS_UPDATE",
  PARAMETERS_GET: "RECLAIM_PARAMETERS_GET",
  REPORT_PROVIDER_ERROR: "RECLAIM_REPORT_PROVIDER_ERROR",
  SET_EXPECT_MANY_CLAIMS: "RECLAIM_SET_EXPECT_MANY_CLAIMS",
  REQUEST_CLAIM: "RECLAIM_REQUEST_CLAIM",
};

export const RECLAIM_SESSION_STATUS = {
  SESSION_INIT: "SESSION_INIT",
  SESSION_STARTED: "SESSION_STARTED",
  USER_INIT_VERIFICATION: "USER_INIT_VERIFICATION",
  USER_STARTED_VERIFICATION: "USER_STARTED_VERIFICATION",
  PROOF_GENERATION_STARTED: "PROOF_GENERATION_STARTED",
  PROOF_GENERATION_SUCCESS: "PROOF_GENERATION_SUCCESS",
  PROOF_GENERATION_FAILED: "PROOF_GENERATION_FAILED",
  PROOF_SUBMITTED: "PROOF_SUBMITTED",
  PROOF_SUBMISSION_FAILED: "PROOF_SUBMISSION_FAILED",
  PROOF_MANUAL_VERIFICATION_SUBMITED: "PROOF_MANUAL_VERIFICATION_SUBMITED",
};

export const MESSAGE_SOURCES = {
  CONTENT_SCRIPT: "content-script",
  BACKGROUND: "background",
  OFFSCREEN: "offscreen",
};

export const MESSAGE_ACTIONS = {
  // Proof generation actions
  START_VERIFICATION: "START_VERIFICATION",
  CANCEL_VERIFICATION: "CANCEL_VERIFICATION",
  GENERATE_PROOF_REQUEST: "GENERATE_PROOF_REQUEST",
  CLAIM_CREATION_REQUESTED: "CLAIM_CREATION_REQUESTED",
  CLAIM_CREATION_SUCCESS: "CLAIM_CREATION_SUCCESS",
  CLAIM_CREATION_FAILED: "CLAIM_CREATION_FAILED",
  PROOF_GENERATION_STARTED: "PROOF_GENERATION_STARTED",
  PROOF_GENERATION_SUCCESS: "PROOF_GENERATION_SUCCESS",
  PROOF_GENERATION_FAILED: "PROOF_GENERATION_FAILED",
  PROOF_SUBMITTED: "PROOF_SUBMITTED",
  PROOF_SUBMISSION_FAILED: "PROOF_SUBMISSION_FAILED",
  GENERATE_PROOF: "GENERATE_PROOF",
  GENERATED_PROOF_RESPONSE: "GENERATED_PROOF_RESPONSE",
  GENERATE_CLAIM_ON_ATTESTOR: "GENERATE_CLAIM_ON_ATTESTOR",
  GET_PRIVATE_KEY: "GET_PRIVATE_KEY",
  GET_PRIVATE_KEY_RESPONSE: "GET_PRIVATE_KEY_RESPONSE",

  // UI actions
  SHOW_PROVIDER_VERIFICATION_POPUP: "SHOW_PROVIDER_VERIFICATION_POPUP",
  OFFSCREEN_DOCUMENT_READY: "OFFSCREEN_DOCUMENT_READY",

  // Offscreen actions
  GENERATE_PROOF_RESPONSE: "GENERATE_PROOF_RESPONSE",
  PING_OFFSCREEN: "PING_OFFSCREEN",

  // Background actions
  CLOSE_CURRENT_TAB: "CLOSE_CURRENT_TAB",
  GET_CURRENT_TAB_ID: "GET_CURRENT_TAB_ID",
  // Content script actions
  REQUEST_PROVIDER_DATA: "REQUEST_PROVIDER_DATA",
  PROVIDER_DATA_READY: "PROVIDER_DATA_READY",
  CONTENT_SCRIPT_LOADED: "CONTENT_SCRIPT_LOADED",
  SHOULD_INITIALIZE: "SHOULD_INITIALIZE",
  CHECK_IF_MANAGED_TAB: "CHECK_IF_MANAGED_TAB",

  // Interceptor actions
  FILTERED_REQUEST_FOUND: "FILTERED_REQUEST_FOUND",
  INTERCEPTED_REQUEST_AND_RESPONSE: "INTERCEPTED_REQUEST_AND_RESPONSE",

  // Injection script actions
  UPDATE_PUBLIC_DATA: "UPDATE_PUBLIC_DATA",
  UPDATE_EXPECT_MANY_CLAIMS: "UPDATE_EXPECT_MANY_CLAIMS",
  GET_PARAMETERS: "GET_PARAMETERS",
  REPORT_PROVIDER_ERROR: "REPORT_PROVIDER_ERROR",
  REQUEST_CLAIM: "REQUEST_CLAIM",
};

/**
 * @typedef {Object} ProviderData
 * @property {string} httpProviderId - Provider ID
 * @property {string} name - Provider name
 * @property {string} description - Provider description
 * @property {string} logoUrl - URL to provider logo
 * @property {boolean} disableRequestReplay - Whether request replay is disabled
 * @property {string} loginUrl - URL to provider login page
 * @property {string} customInjection - Custom injection code
 * @property {boolean} isApproved - Whether provider is approved
 * @property {string} geoLocation - Geo location
 * @property {string} providerType - Provider type
 * @property {boolean} isVerified - Whether provider is verified
 * @property {string} injectionType - Injection type
 * @property {Object} userAgent - User agent info
 * @property {string} userAgent.ios - iOS user agent
 * @property {string} userAgent.android - Android user agent
 * @property {boolean} isActive - Whether provider is active
 * @property {string|null} expectedPageUrl - Expected page URL
 * @property {string|null} pageTitle - Page title
 * @property {string|null} stepsToFollow - Steps to follow
 * @property {number} usedInCount - Number of times used
 * @property {string|null} overseerUid - Overseer UID
 * @property {string|null} overseerNote - Overseer note
 * @property {Array<RequestData>} requestData - Request data
 */

/**
 * @typedef {Object} RequestData
 * @property {string} url - Request URL
 * @property {string} expectedPageUrl - Expected page URL
 * @property {string} urlType - URL type
 * @property {string} method - HTTP method
 * @property {Array<ResponseMatch>} responseMatches - Response matches
 * @property {Array<ResponseRedaction>} responseRedactions - Response redactions
 * @property {BodySniff} bodySniff - Body sniff
 * @property {string} requestHash - Request hash
 * @property {string|null} additionalClientOptions - Additional client options
 */

/**
 * @typedef {Object} ResponseMatch
 * @property {string} value - Match value
 * @property {string} type - Match type
 * @property {boolean} invert - Whether to invert the match
 * @property {string|null} description - Match description
 * @property {number|null} order - Match order
 */

/**
 * @typedef {Object} ResponseRedaction
 * @property {string} xPath - XPath
 * @property {string} jsonPath - JSON path
 * @property {string} regex - Regular expression
 * @property {string} hash - Hash
 */

/**
 * @typedef {Object} BodySniff
 * @property {boolean} enabled - Whether body sniffing is enabled
 * @property {string} template - Body template
 */
