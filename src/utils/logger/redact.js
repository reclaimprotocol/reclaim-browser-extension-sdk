/**
 * Redaction for objects that get stringified into log lines.
 *
 * Diagnostic logs leave the device: they are POSTed to the logging endpoint and
 * land in Loki, where they are readable by anyone with dashboard access. Two
 * kinds of value must never make that trip:
 *
 *  - credentials — `signature` authenticates the session-init request
 *  - user data — `parameters` holds whatever the provider script needs, which
 *    for a real provider is exactly the sensitive value being proven (account
 *    number, email, balance)
 *
 * Keys are matched case-insensitively on substrings, so `appSecret`,
 * `secretKey` and `SECRET` are all caught by one entry. The shape is preserved
 * — a redacted log still shows which fields were present, which is usually the
 * diagnostic question — and the value is replaced with a marker that records
 * enough to correlate without disclosing.
 */

const SENSITIVE_KEY_PATTERNS = [
  "signature",
  "secret",
  "password",
  "token",
  "cookie",
  "authorization",
  "privatekey",
  "apikey",
];

/**
 * Keys whose values are user data: keep the key names, drop the values.
 *
 * These are matched whatever the value's TYPE is. That matters because the
 * attestor hands several of them back as JSON *strings* rather than objects —
 * `claim.parameters` is a serialised blob holding `paramValues`, and a
 * string-only-if-object check let the whole thing through untouched.
 */
const USER_DATA_KEYS = ["parameters", "paramvalues", "publicdata", "witnessparameters"];

/**
 * Keys replaced wholesale, without descending into them.
 *
 * `claimData` is the attestor's claim: `parameters` (the substituted request,
 * including `paramValues`) and `context` (which carries `extractedParameters` —
 * the plaintext value the user is proving). There is nothing inside it worth
 * keeping at INFO, and walking it key-by-key means every future field the
 * attestor adds is exposed until someone remembers to list it here. The InApp
 * SDK blanks exactly this field in its own PROOF_GENERATED line.
 *
 * `rdObject` is the request descriptor a provider script hands to
 * `window.Reclaim.requestClaim()`. Like `injectionResult` it is provider-shaped
 * — it routinely carries the response the claim is being built from — so no
 * substring rule can anticipate its key names either.
 */
const OPAQUE_KEYS = ["claimdata", "context", "extractedparameters", "injectionresult", "rdobject"];

/**
 * Keys carrying raw response or page content as a STRING.
 *
 * `USER_DATA_KEYS` only covers object values, so a plain string of the user's
 * authenticated page would otherwise travel verbatim. The length is kept
 * because it is the actual diagnostic: it separates "the selector matched
 * nothing" from "it matched the wrong region". Deliberately narrow — bare
 * `body` is NOT here, because a claim's `params.body` is a provider-authored
 * request template, which is config worth reading, not user data.
 */
const RESPONSE_CONTENT_KEYS = ["element", "responsebody", "responsetext"];

function isSensitive(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isUserData(key) {
  return USER_DATA_KEYS.includes(String(key).toLowerCase());
}

function isOpaque(key) {
  return OPAQUE_KEYS.includes(String(key).toLowerCase());
}

function isResponseContent(key) {
  return RESPONSE_CONTENT_KEYS.includes(String(key).toLowerCase());
}

/**
 * Deep-copy `value` with sensitive fields replaced.
 *
 * @param {*} value
 * @param {number} [depth] - recursion guard for cyclic or pathological objects
 * @returns {*}
 */
export function redact(value, depth = 0) {
  if (depth > 8) return "<max-depth>";
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitive(key)) {
      out[key] = typeof val === "string" ? `<redacted:${val.length} chars>` : "<redacted>";
    } else if (isOpaque(key)) {
      out[key] = "[REDACTED]";
    } else if (isUserData(key)) {
      // Field names are safe and useful; the values are the user's data. An
      // object keeps its key names; a string (the attestor serialises several of
      // these) keeps only its length.
      out[key] =
        val && typeof val === "object"
          ? `<redacted keys: ${Object.keys(val).join(", ") || "none"}>`
          : typeof val === "string"
            ? `<redacted:${val.length} chars>`
            : "<redacted>";
    } else if (isResponseContent(key) && typeof val === "string") {
      out[key] = `<redacted:${val.length} chars>`;
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

/**
 * Redact then stringify, for direct interpolation into a log line.
 *
 * @param {*} value
 * @returns {string}
 */
export function redactedJson(value) {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return "<unserializable>";
  }
}

/**
 * Stringify WITHOUT redacting, for the FINE log path.
 *
 * Everything in the module header applies in reverse here: a value serialised by
 * this function reaches Loki verbatim, credentials included. That is the point
 * of FINE — a claim that fails at the attestor is only diagnosable from the
 * exact bytes that were sent, and a client's failing session has to be readable
 * remotely, with their permission.
 *
 * One guard, and it must stay: `LoggingHub._addLog` reaches this function only
 * while `logLevel` is FINE, which is never the default. At INFO every payload
 * goes through `redact()` instead, for the console as well as the endpoint.
 *
 * @param {*} value
 * @returns {string}
 */
export function unredactedJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}
