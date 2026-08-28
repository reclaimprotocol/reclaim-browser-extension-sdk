export const LOGGING_ENDPOINTS = {
  DIAGNOSTIC_LOGGING: "https://logs.reclaimprotocol.org/api/business-logs/logDump",
};

export const LOG_SOURCES = {
  BACKGROUND: "background",
  CONTENT: "content",
  OFFSCREEN: "offscreen",
  POPUP: "popup",
  INJECTION: "injection",
};

/**
 * Canonical event taxonomy, reconciled against the InApp SDK's `LogEventType`
 * (reclaim-inapp-sdk/lib/src/logging/event_type.dart).
 *
 * A name that exists upstream MUST be spelled the same way here — the whole
 * point is that one Grafana query works across SDKs. Names that used to differ
 * were renamed to InApp's spelling:
 *
 *   RESPONSE_MATCH_FAILED        → NO_RESPONSE_MATCH_WARNING
 *   CLAIM_CREATION_SUCCESS       → PROOF_GENERATED
 *   CLAIM_CREATION_FAILED        → PROOF_GENERATION_FAILED_EXCEPTION
 *   PROOF_GENERATION_ABORTED     → CLAIM_CREATION_CANCELLED_EXCEPTION
 *   VERIFICATION_FLOW_FAILED     → RECLAIM_EXCEPTION
 *   FILTERED_REQUEST_FOUND       → dropped; it duplicated REQUEST_MATCHED
 *   SUBMITTING_PROOF_TO_CALLBACK_URL{,_SUCCESS,_FAILED}
 *                                → SUBMITTING_PROOF / PROOF_SUBMITTED /
 *                                  PROOF_SUBMISSION_FAILED (the callback URL is
 *                                  where submission goes, not a distinct event)
 *
 * `IS_RECLAIM_EXTENSION_SDK` intentionally keeps its own name — it is the
 * per-SDK identity marker, InApp's equivalents being IS_RECLAIM_INAPPSDK and
 * IS_RECLAIM_VERIFIER.
 *
 * Before adding a name, check event_type.dart for one that already means this.
 */
export const EVENT_TYPES = {
  // --- Session and flow lifecycle ---
  IS_RECLAIM_EXTENSION_SDK: "IS_RECLAIM_EXTENSION_SDK",
  VERIFICATION_FLOW_STARTED: "VERIFICATION_FLOW_STARTED",
  USER_STARTED_VERIFICATION: "USER_STARTED_VERIFICATION",
  FETCHED_PROVIDERS: "FETCHED_PROVIDERS",
  LOADING_INITIAL_URL: "LOADING_INITIAL_URL",
  WEB_PAGE_READY: "WEB_PAGE_READY",
  PAGE_LOADING_STARTED: "PAGE_LOADING_STARTED",
  PAGE_LOADING_STOPPED: "PAGE_LOADING_STOPPED",

  // --- Request interception and matching ---
  REQUEST_INTERCEPTED: "REQUEST_INTERCEPTED",
  REQUEST_MATCHED: "REQUEST_MATCHED",
  NO_RESPONSE_MATCH_WARNING: "NO_RESPONSE_MATCH_WARNING",
  X_PATH_MATCH_REQUIREMENT_FAILED: "X_PATH_MATCH_REQUIREMENT_FAILED",
  JSON_PATH_MATCH_REQUIREMENT_FAILED: "JSON_PATH_MATCH_REQUIREMENT_FAILED",
  REGEX_MATCH_REQUIREMENT_FAILED: "REGEX_MATCH_REQUIREMENT_FAILED",
  FILTER_REQUEST_ERROR: "FILTER_REQUEST_ERROR",

  // --- Claim creation ---
  PROVIDER_SCRIPT_REQUESTED_CLAIM: "PROVIDER_SCRIPT_REQUESTED_CLAIM",
  STARTING_CLAIM_CREATION: "STARTING_CLAIM_CREATION",
  PREPARING_CLAIM: "PREPARING_CLAIM",
  VALIDATING_CLAIM_PARAMETERS: "VALIDATING_CLAIM_PARAMETERS",
  NO_PARAMETERS_FOUND: "NO_PARAMETERS_FOUND",
  CLAIM_PARAMETER_VALIDATION_FAILED_EXCEPTION: "CLAIM_PARAMETER_VALIDATION_FAILED_EXCEPTION",
  CLAIM_CREATION_STARTED: "CLAIM_CREATION_STARTED",
  CLAIM_CREATION_CANCELLED_EXCEPTION: "CLAIM_CREATION_CANCELLED_EXCEPTION",
  CLAIM_CREATION_TIMED_OUT_EXCEPTION: "CLAIM_CREATION_TIMED_OUT_EXCEPTION",

  // --- Proof generation ---
  PROOF_GENERATION_STARTED: "PROOF_GENERATION_STARTED",
  PROOF_GENERATED: "PROOF_GENERATED",
  PROOF_GENERATION_SUCCESS: "PROOF_GENERATION_SUCCESS",
  PROOF_GENERATION_FAILED: "PROOF_GENERATION_FAILED",
  PROOF_GENERATION_FAILED_EXCEPTION: "PROOF_GENERATION_FAILED_EXCEPTION",
  ATTESTOR_NOT_RESPONDING: "ATTESTOR_NOT_RESPONDING",
  RESULT_RECEIVED: "RESULT_RECEIVED",

  // --- Submission ---
  SUBMITTING_PROOF: "SUBMITTING_PROOF",
  PROOF_SUBMITTED: "PROOF_SUBMITTED",
  PROOF_SUBMISSION_FAILED: "PROOF_SUBMISSION_FAILED",

  // --- Terminal states and exceptions ---
  RECLAIM_VERIFICATION_DISMISSED: "RECLAIM_VERIFICATION_DISMISSED",
  RECLAIM_VERIFICATION_CANCELLED_EXCEPTION: "RECLAIM_VERIFICATION_CANCELLED_EXCEPTION",
  RECLAIM_VERIFICATION_PROVIDER_LOAD_EXCEPTION: "RECLAIM_VERIFICATION_PROVIDER_LOAD_EXCEPTION",
  RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION:
    "RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION",
  RECLAIM_INIT_SESSION_EXCEPTION: "RECLAIM_INIT_SESSION_EXCEPTION",
  INVALID_REQUEST_RECLAIM_EXCEPTION: "INVALID_REQUEST_RECLAIM_EXCEPTION",
  RECLAIM_EXCEPTION: "RECLAIM_EXCEPTION",
  UNKNOWN: "UNKNOWN",

  // --- Extension-only: no InApp analogue, because the mechanism doesn't exist
  // there (MV3 offscreen documents, browser tabs, the injected popup).
  OFFSCREEN_DOCUMENT_READY: "OFFSCREEN_DOCUMENT_READY",
  OFFSCREEN_DOCUMENT_NOT_READY_EXCEPTION: "OFFSCREEN_DOCUMENT_NOT_READY_EXCEPTION",
  TAB_NOT_MANAGED_BY_EXTENSION_EXCEPTION: "TAB_NOT_MANAGED_BY_EXTENSION_EXCEPTION",
  INJECTION_SCRIPT_SET_IN_LOCAL_STORAGE_FAILED: "INJECTION_SCRIPT_SET_IN_LOCAL_STORAGE_FAILED",
  VERIFICATION_POPUP_ERROR: "VERIFICATION_POPUP_ERROR",
  UPDATE_SESSION_STATUS_ERROR: "UPDATE_SESSION_STATUS_ERROR",
};

/**
 * Log levels (lower number = higher severity), spelled the way the rest of the
 * platform spells them.
 *
 * The names are NOT arbitrary. The InApp SDK, the Portal and the log viewer all
 * speak Java-style levels, and the logs API only accepts
 * `fine | config | info | warning | severe` when filtering by severity. The
 * extension used to emit ERROR/WARN/DEBUG, which meant its lines could not be
 * filtered by severity alongside the other SDKs' at all.
 *
 * There are only two levels a caller has to think about:
 *
 *   INFO — the default. Everything about the session, with values REDACTED.
 *   FINE — opt-in. The same information with values RAW.
 *
 * WARNING and SEVERE are more severe than INFO, so they are always visible at
 * the default threshold; they exist so a query can isolate failures, not to
 * hide anything.
 */
export const LOG_LEVEL = {
  SEVERE: 1,
  WARNING: 2,
  INFO: 3,
  FINE: 4,
};

/**
 * Pre-rename spellings, still accepted from consumers and from older callers.
 * `DEBUG` maps to FINE, which is the level that now carries raw values.
 */
const LOG_LEVEL_ALIASES = {
  ERROR: "SEVERE",
  WARN: "WARNING",
  WARNING: "WARNING",
  DEBUG: "FINE",
  TRACE: "FINE",
  FINER: "FINE",
  FINEST: "FINE",
  CONFIG: "INFO",
};

/**
 * Resolve any accepted spelling to a canonical level name.
 *
 * @param {string} level
 * @param {string} [fallback] - used when `level` is absent or unrecognised
 * @returns {"SEVERE"|"WARNING"|"INFO"|"FINE"}
 */
export function normalizeLogLevel(level, fallback = "INFO") {
  if (!level) return fallback;
  const upper = String(level).toUpperCase();
  if (LOG_LEVEL[upper] !== undefined) return upper;
  return LOG_LEVEL_ALIASES[upper] || fallback;
}

export const DEFAULT_LOG_CONFIG = {
  // The ONLY threshold. It governs the console and the remote endpoint
  // together, so both destinations always hold the same text — there is no
  // longer a level at which the console shows something the endpoint does not.
  //
  //   INFO — redacted. No response bodies, no extracted values, no claim
  //          payload, no credentials. Safe as a default for an extension that
  //          ships to end users.
  //   FINE — raw. Response bodies, real parameter values, the full claim
  //          (owner private key, session cookies) and the full proof. Sent to
  //          the endpoint as well, which is the point: it is how a client's
  //          failing session gets diagnosed remotely, with their permission.
  //
  // FINE is never a default and should be set per verification rather than
  // left on a device:
  //   reclaimExtensionSDK.init(..., { logConfig: { logLevel: "FINE" } })
  logLevel: "INFO", // "SEVERE" | "WARNING" | "INFO" | "FINE"

  // Off by default, and independent of the level. A consumer extension ships
  // to end users and the content-script console is the *provider tab's*
  // console — a verification would otherwise narrate itself in the user's own
  // devtools. Diagnostics still reach the endpoint; this only mirrors locally.
  //
  // Turn it on while developing:
  //   reclaimExtensionSDK.setLogConfig({ consoleEnabled: true, logLevel: "FINE" })
  // then read the service worker (chrome://extensions → "service worker"), the
  // offscreen document (same page → "Inspect views: offscreen/offscreen.html"),
  // and the provider tab's own console.
  consoleEnabled: false,
};

export const LOG_CONFIG_STORAGE_KEY = "reclaim_extension_sdk_log_config";

// Where the pending log queue is parked so it survives a service-worker
// restart. `chrome.storage.session` is the right store: it is cleared when the
// browser closes, so logs never outlive the browsing session that produced
// them, but it does survive the MV3 worker being torn down mid-flow.
export const LOG_QUEUE_STORAGE_KEY = "reclaim_extension_sdk_log_queue";

// Name of the chrome.alarms alarm used for the periodic flush, when the
// `alarms` permission is present. See LoggingHub._startFlushSchedule.
export const LOG_FLUSH_ALARM_NAME = "reclaim-log-flush";
