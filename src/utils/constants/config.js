/**
 * SDK Configuration Constants
 *
 * Centralized timeouts, intervals, and limits used across the SDK.
 * Adjust these values to tune performance and behavior.
 */

// --- Proof Generation ---

/**
 * ZK engine used when a provider doesn't specify one in
 * `extensionConfig.zkEngine`.
 *
 * This must be an engine the pinned attestor-core's **prebuilt browser bundle**
 * actually registers a ZK operator maker for, otherwise proof generation dies in
 * the offscreen document with "No ZK operator maker for <engine>". The bundle is
 * a checked-in artifact upstream and its engine support has silently changed
 * between patch releases — see attestor-zk-engine.test.js, which guards this.
 */
export const DEFAULT_ZK_ENGINE = "stwo";

/**
 * Max time for attestor proof generation in offscreen document (ms).
 *
 * This is the real proof budget: offscreen.js races `createClaimOnAttestor`
 * against it.
 */
export const PROOF_GENERATION_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Max time the background waits for the offscreen document's response (ms).
 *
 * **Must stay strictly greater than PROOF_GENERATION_TIMEOUT_MS**, hence the
 * derivation rather than a literal. It was 60s against an inner 120s, so the
 * outer timeout always won: a proof that legitimately needed 60–120s was killed
 * by the background while the offscreen document was still working, and the
 * inner timeout could never surface at all. The session then failed with the
 * vaguer "Timeout waiting for offscreen document" instead of the offscreen's
 * own "Proof generation timed out after 120 seconds".
 *
 * The headroom covers the PROOF_GENERATION_FAILED `updateSessionStatus` POST
 * the offscreen makes on its way out, plus the chrome-messaging hop. This
 * timeout is now only a backstop for an offscreen document that died without
 * answering at all.
 */
export const PROOF_RESPONSE_TIMEOUT_MS = PROOF_GENERATION_TIMEOUT_MS + 15000; // 2m15s

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

/**
 * Periodic flush period when `chrome.alarms` is used instead of setInterval.
 * Chrome clamps alarm periods to a 30-second minimum in released extensions, so
 * this is the floor, not a preference. The alarm is a backstop against worker
 * death — batch-size and terminal-event flushes do the routine work.
 */
export const LOG_FLUSH_ALARM_PERIOD_MINUTES = 0.5;

/**
 * Max characters of a single log line kept before truncation.
 *
 * Matches the InApp SDK's cap. Without it, one `JSON.stringify(providerData)`
 * can be hundreds of kilobytes, which is why the logs backend needs
 * `splitLargeEntry` at all — and an oversized batch is more likely to be
 * rejected outright, taking every other log in the batch with it.
 */
export const LOG_MAX_LINE_LENGTH = 2000;

/**
 * Cap for a log line carrying a RAW payload, i.e. one emitted at FINE.
 *
 * Deliberately far above LOG_MAX_LINE_LENGTH: a real claim — request body
 * template, cookie header, response redactions — runs well past 2000
 * characters, so the normal cap would cut off exactly the half being asked for.
 *
 * Finite rather than absent, though. An oversized POST is rejected outright, and
 * a rejected batch stays queued for retry, so one runaway payload would block
 * every later batch behind it. This bounds that without truncating a real claim.
 */
export const LOG_MAX_UNREDACTED_LINE_LENGTH = 100_000;

// --- Custom Injection ---

/** Timeout waiting for provider ID from extension during injection (ms) */
export const INJECTION_PROVIDER_ID_TIMEOUT_MS = 5000; // 5 seconds
