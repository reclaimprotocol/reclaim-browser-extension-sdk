/**
 * Redaction rules for the Builder analytics events that diagnostic mode used
 * to suppress outright: `provider_script_log` and
 * `request_claim_parameters_captured`. Builder always emits these two events
 * now; diagnostic mode only changes how much detail a payload carries.
 *
 * `network_request_observed` (the third event that diagnostics used to gate)
 * keeps its existing all-or-nothing gate instead: it fires once per
 * intercepted request, so a multi-page login flow can produce hundreds per
 * session, and emitting it unconditionally would flood Builder's event
 * ingestion. See the diagnostic-mode branch in `background.js`.
 *
 * These rules mirror the in-app SDK's `lib/src/utils/sanitize.dart` and
 * `lib/src/ui/claim_creation_webview/builder_request_events.dart` — one
 * shared redaction policy, two implementations. Keep the two in step.
 *
 * Pulled out of `messageRouter.js` so the redaction rules stay independently
 * testable, the way `builder-transition.js` already separates its state
 * transition from the service-worker module.
 */

const REDACTED = "[REDACTED]";

// Key names are matched with a short leading run so prefixed forms
// (access_token, user_email) are still caught. The run is bounded because
// its length is the dominant cost of the scan.
const KEY_PREFIX = "[\\w-]{0,16}";

const SECRET_KEYS =
  "(?:secret|password|passwd|pwd|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)";

const PII_KEYS =
  "(?:email|mail|phone|phone[_-]?number|mobile(?:[_-]?number)?|msisdn|first[_-]?name|last[_-]?name|full[_-]?name" +
  "|dob|date[_-]?of[_-]?birth|birth[_-]?date|aadhaar|aadhar|aadhaar[_-]?number|pan|pan[_-]?number|ssn" +
  "|passport(?:[_-]?number)?|account(?:[_-]?number)?|bank[_-]?account|ifsc|iban|card[_-]?number|cvv)";

// Credential tier only: cookies, authorization headers, bearer tokens, JWTs,
// private keys, secrets/passwords/tokens/API keys, proof data, proofString,
// and raw request/response bodies. Personal data (email, phone, and the
// other PII_KEYS) is matched separately by PERSONAL_DATA_PATTERN so a caller
// can drop one tier without the other.
const CREDENTIAL_PATTERN = new RegExp(
  "-----BEGIN[^-]*PRIVATE[^-]*KEY-----[\\s\\S]*?-----END[^-]*PRIVATE[^-]*KEY-----" +
    "|\\b(?:" +
    "set-cookie\\s*[:=]\\s*[^\\n;,]+" +
    "|(?<!set-)cookie\\s*[:=]\\s*[^\\n]+" +
    "|authorization\\s*[:=]\\s*[^\\n\\r,}]+" +
    "|bearer\\s+\\S+" +
    "|eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+" +
    `|${KEY_PREFIX}${SECRET_KEYS}\\s*[:=]\\s*\\S+` +
    `|${KEY_PREFIX}proof(?:String)?\\s*[:=]\\s*\\S+` +
    `|${KEY_PREFIX}(?:(?:request|response)[Bb]ody|payload|body)\\s*[:=]\\s*\\S+` +
    ")",
  "gi",
);

// URL query params carrying PII — value runs until the next `&`, whitespace,
// or structural punctuation. Catches URL-encoded forms (for example,
// `email=foo%40bar.com`) the plain-email pattern below would miss.
const PERSONAL_DATA_PATTERN = new RegExp(
  `\\b(?:${KEY_PREFIX}${PII_KEYS}\\s*=\\s*[^&\\s,;}"']+` +
    "|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}" +
    ")",
  "gi",
);

function replaceSensitiveMatch(match) {
  const colonIdx = match.indexOf(":");
  const eqIdx = match.indexOf("=");
  let sepIdx = -1;
  if (colonIdx !== -1 && eqIdx !== -1) {
    sepIdx = colonIdx < eqIdx ? colonIdx : eqIdx;
  } else if (colonIdx !== -1) {
    sepIdx = colonIdx;
  } else {
    sepIdx = eqIdx;
  }

  if (sepIdx !== -1) {
    let prefixEnd = sepIdx + 1;
    while (prefixEnd < match.length && (match[prefixEnd] === " " || match[prefixEnd] === "\t")) {
      prefixEnd++;
    }
    return `${match.slice(0, prefixEnd)}${REDACTED}`;
  }

  if (match.toLowerCase().startsWith("bearer")) {
    let prefixEnd = 6;
    while (prefixEnd < match.length && (match[prefixEnd] === " " || match[prefixEnd] === "\t")) {
      prefixEnd++;
    }
    return `${match.slice(0, prefixEnd)}${REDACTED}`;
  }

  return REDACTED;
}

/**
 * Redacts only the credential tier: cookies, authorization headers, bearer
 * tokens, JWTs, private keys, secrets/passwords/tokens/API keys, proof data,
 * proofString, and raw request/response bodies.
 *
 * This is the one redaction Builder diagnostic mode does not relax. Builder
 * has no encrypted-event format — event data lands in a plain JSONB column —
 * so a credential that reaches this function's caller is a security
 * incident, not a triage trade-off the way an un-redacted email address is.
 * Call this on every value a Builder event sends in diagnostic mode, even
 * though diagnostic mode is otherwise allowed to carry personal data. Do not
 * remove this call to finish wiring up diagnostic-mode detail; personal data
 * and credentials are two different tiers, and only the first one is meant
 * to unlock under `diag=1`.
 */
export function redactCredentials(message) {
  if (typeof message !== "string") return message;
  try {
    return message.replace(CREDENTIAL_PATTERN, replaceSensitiveMatch);
  } catch {
    return message;
  }
}

/**
 * Redacts both tiers: the credential tier (see `redactCredentials`) and
 * personal data (email, phone, and similar direct identifiers). Used for
 * normal-mode event payloads, where both tiers stay redacted.
 */
export function sanitizeMessage(message) {
  if (typeof message !== "string") return message;
  try {
    const withoutCredentials = message.replace(CREDENTIAL_PATTERN, replaceSensitiveMatch);
    return withoutCredentials.replace(PERSONAL_DATA_PATTERN, replaceSensitiveMatch);
  } catch {
    return message;
  }
}

/** The cap applied to a normal-mode `provider_script_log` message. */
export const MAX_NORMAL_MESSAGE_LENGTH = 2000;

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/**
 * The most `provider_script_log` events reported for one session.
 *
 * Provider scripts are author-controlled, not claimant-controlled, and
 * `window.Reclaim.log` can be called from a loop. Each `provider_script_log`
 * emission is an awaited HTTP POST to Builder plus a stored event row, so an
 * unbounded provider script is a write-amplification vector against
 * Builder's event ingestion, not just a noisy log. Cap it instead of
 * trusting the script to behave.
 */
export const MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION = 50;

/** What a caller should do with the next `provider_script_log` call. */
export const ProviderScriptLogAction = Object.freeze({
  /** Report the event normally. */
  REPORT: "report",
  /**
   * The cap was just reached with this call: report one final event noting
   * that, instead of the call's own payload, so the cutoff is visible rather
   * than a silent gap in the event stream.
   */
  REPORT_CAP_REACHED_NOTICE: "report-cap-reached-notice",
  /** The cap was already reached by an earlier call: drop this one. */
  DROP: "drop",
});

/**
 * Decides the `ProviderScriptLogAction` for a `provider_script_log` call,
 * given `countSoFarIncludingThisOne` — the number of times the caller has
 * been asked to report one, this session, including the current call.
 */
export function decideProviderScriptLogAction(countSoFarIncludingThisOne) {
  if (countSoFarIncludingThisOne <= MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION) {
    return ProviderScriptLogAction.REPORT;
  }
  if (countSoFarIncludingThisOne === MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION + 1) {
    return ProviderScriptLogAction.REPORT_CAP_REACHED_NOTICE;
  }
  return ProviderScriptLogAction.DROP;
}

/**
 * The message reported once, in place of the event that hit the cap, when
 * `decideProviderScriptLogAction` returns `REPORT_CAP_REACHED_NOTICE`.
 */
export const PROVIDER_SCRIPT_LOG_CAP_REACHED_MESSAGE =
  `provider_script_log cap of ${MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION} events reached for this session; ` +
  "further provider script logs are not reported.";

/**
 * Builds the `provider_script_log` event payload for one provider script log
 * call.
 *
 * `provider_script_log` is always emitted (subject to the per-session cap
 * above); `diagnosticMode` only changes how much of the message it carries:
 * a sanitized message capped at `MAX_NORMAL_MESSAGE_LENGTH` in normal mode,
 * or the full, untruncated message — with credentials still redacted — in
 * diagnostic mode.
 */
export function providerScriptLogEventData({ level, message, diagnosticMode }) {
  return {
    level,
    message: diagnosticMode
      ? redactCredentials(message)
      : sanitizeMessage(truncate(message, MAX_NORMAL_MESSAGE_LENGTH)),
  };
}

/**
 * Redacts `value` when `name` is a credential-shaped key.
 *
 * `redactCredentials` matches on `name=value` text, so the name is folded
 * back in before the check and stripped back out afterward — this keeps the
 * one credential pattern above as the single source of truth for which key
 * names count as a credential, instead of duplicating that list here.
 */
function redactedParameterValue(name, value) {
  const stringValue = typeof value === "string" ? value : JSON.stringify(value);
  const redacted = redactCredentials(`${name}=${stringValue}`);
  const separatorIndex = redacted.indexOf("=");
  return separatorIndex === -1 ? redacted : redacted.slice(separatorIndex + 1);
}

/**
 * Builds the `request_claim_parameters_captured` event payload for one
 * captured set of claim parameters.
 *
 * `request_claim_parameters_captured` is always emitted; `diagnosticMode`
 * only changes whether parameter values accompany their names: names only in
 * normal mode, names and values in diagnostic mode. A parameter whose name is
 * credential-shaped (`apiKey`, `password`, `authToken`, and so on) still
 * reports its value as redacted in diagnostic mode — credential redaction is
 * unconditional, not a diagnostics trade-off.
 */
export function requestClaimParametersCapturedEventData({ parameterValuesByName, diagnosticMode }) {
  const parameterNames = Object.keys(parameterValuesByName || {}).sort();
  if (!diagnosticMode) {
    return { parameterNames };
  }
  const parameterValues = {};
  for (const name of parameterNames) {
    parameterValues[name] = redactedParameterValue(name, parameterValuesByName[name]);
  }
  return { parameterNames, parameterValues };
}

/**
 * Decides whether a `CONTENT_SCRIPT_LOADED` message should report
 * `verification_page_ready`.
 *
 * `verification_page_ready` is documented as a per-provider milestone
 * ("provider page became usable") that must fire at most once per provider,
 * on the first page load observed after that provider starts. The content
 * script resends `CONTENT_SCRIPT_LOADED` on every full-page navigation in the
 * managed tab (a login page, a two-factor step, a post-login redirect, and so
 * on), since each one reinjects and resends it, so the caller must track, per
 * provider, whether one has already been reported. `hasAlreadyEmittedPageReadyForProvider`
 * is that caller-owned state (mirrors the in-app SDK's `shouldEmitPageReady`
 * in `builder_request_events.dart`, to which the same reasoning applies);
 * this returns `true` only when nothing has been reported yet for the
 * current provider.
 */
export function shouldEmitPageReady({ hasAlreadyEmittedPageReadyForProvider }) {
  return !hasAlreadyEmittedPageReadyForProvider;
}
