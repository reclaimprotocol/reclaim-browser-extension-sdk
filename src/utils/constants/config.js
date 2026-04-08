/**
 * SDK Configuration Constants
 *
 * Centralized timeouts, intervals, and limits used across the SDK.
 * Adjust these values to tune performance and behavior.
 */

// --- Proof Generation ---

/** Max time for attestor proof generation in offscreen document (ms) */
export const PROOF_GENERATION_TIMEOUT_MS = 120000; // 2 minutes

/** Max time waiting for proof generation response from offscreen (ms) */
export const PROOF_RESPONSE_TIMEOUT_MS = 60000; // 1 minute

/** Max time waiting for private key generation from offscreen (ms) */
export const PRIVATE_KEY_TIMEOUT_MS = 10000; // 10 seconds

// --- Offscreen Document ---

/** Default timeout waiting for offscreen document readiness (ms) */
export const OFFSCREEN_READY_TIMEOUT_MS = 15000; // 15 seconds

/** Timeout when offscreen context exists but not yet ready (ms) */
export const OFFSCREEN_CONTEXT_EXISTS_TIMEOUT_MS = 5000; // 5 seconds

/** Final timeout for offscreen document initialization (ms) */
export const OFFSCREEN_FINAL_INIT_TIMEOUT_MS = 50000; // 50 seconds

// --- Session & Verification ---

/** Session inactivity timeout — fails if no proof generated within this window (ms) */
export const SESSION_TIMER_DURATION_MS = 30000; // 30 seconds

/** Max time for network request filtering before giving up (ms) */
export const NETWORK_FILTERING_TIMEOUT_MS = 600000; // 10 minutes

/** Interval for checking intercepted network requests (ms) */
export const NETWORK_FILTERING_INTERVAL_MS = 1000; // 1 second

/** Max age for intercepted request/response data before cleanup (ms) */
export const INTERCEPTED_DATA_MAX_AGE_MS = 120000; // 2 minutes

/** Delay before switching tabs after verification completes (ms) */
export const TAB_TRANSITION_DELAY_MS = 3000; // 3 seconds

// --- CSP Rule Management ---

/** Auto-remove CSP stripping rule after this duration as a safety net (ms) */
export const CSP_RULE_MAX_LIFETIME_MS = 120000; // 2 minutes

/** Fixed rule ID for CSP stripping (high number to avoid collision with consumer rules) */
export const CSP_RULE_ID = 9999;

// --- Logging ---

/** Max logs per batch before flushing to API */
export const LOG_MAX_BATCH_SIZE = 20;

/** Max queued logs before dropping oldest (OOM protection) */
export const LOG_MAX_QUEUE_SIZE = 500;

/** Periodic log flush interval (ms) */
export const LOG_FLUSH_INTERVAL_MS = 5000; // 5 seconds

/** Time window for log deduplication (ms) */
export const LOG_DEDUPE_WINDOW_MS = 100; // 100 ms

// --- Custom Injection ---

/** Timeout waiting for provider ID from extension during injection (ms) */
export const INJECTION_PROVIDER_ID_TIMEOUT_MS = 5000; // 5 seconds
