/**
 * Normalizing provider config to what this SDK can actually honour.
 *
 * Provider documents are authored once and consumed by several very different
 * runtimes (InApp/Flutter webview, the portal's headless browser, this
 * extension). They therefore carry fields whose value space is wider than any
 * one runtime supports. Silently passing an unsupported value through means a
 * confusing runtime failure much later — a page with no interceptor, or a claim
 * the attestor rejects — so normalize once, at the point the provider is
 * fetched, and log when a value is coerced.
 */

/**
 * Injection strategies the extension implements.
 *
 * The full upstream enum is MSWJS | XHOOK | HAWKEYE | NONE | CDP
 * (reclaim-sdk-backend `InjectionType`; InApp adds UNKNOWN). This SDK has
 * exactly two behaviours:
 *
 *   HAWKEYE → inject src/interceptor/network-interceptor.js into the MAIN world
 *   NONE    → do not inject an interceptor at all
 *
 * There is no MSWJS/XHOOK/CDP code path here, so anything else falls back to
 * HAWKEYE — which matches InApp, whose deserializer declares
 * `defaultValue: InjectionType.HAWKEYE`. Falling back to NONE instead would
 * silently disable interception and strand the session with no matched request
 * until the session timer fires.
 */
export const INJECTION_TYPES = {
  HAWKEYE: "HAWKEYE",
  NONE: "NONE",
};

export const DEFAULT_INJECTION_TYPE = INJECTION_TYPES.HAWKEYE;

/**
 * The only OPRF mode this SDK supports.
 *
 * The attestor's schema allows `oprf | oprf-mpc | oprf-raw`
 * (attestor-core `HttpProviderParameters.responseRedactions[].hash`). The
 * extension only supports the raw variant, so any other truthy value is coerced
 * rather than sent as-is: an unsupported mode would reach the attestor and fail
 * proof generation after the user has already logged in.
 *
 * `hash` being absent/null is NOT hashing and must stay absent — coercing that
 * would hash a value the provider intended to reveal.
 */
export const SUPPORTED_REDACTION_HASH = "oprf-raw";

/**
 * Coerce a provider's injectionType to one this SDK implements.
 *
 * @param {string} [injectionType] - raw value from provider data
 * @param {Object} [logger] - optional logger, called only when coercing
 * @returns {"HAWKEYE"|"NONE"}
 */
export function normalizeInjectionType(injectionType, logger) {
  if (injectionType === INJECTION_TYPES.NONE) return INJECTION_TYPES.NONE;
  if (injectionType === INJECTION_TYPES.HAWKEYE) return INJECTION_TYPES.HAWKEYE;

  logger?.warn?.(
    `[PROVIDER] Unsupported injectionType ${JSON.stringify(injectionType)}; ` +
      `falling back to ${DEFAULT_INJECTION_TYPE}`,
    "background.provider",
  );
  return DEFAULT_INJECTION_TYPE;
}

/**
 * Coerce a responseRedaction `hash` to the one supported OPRF mode.
 *
 * @param {string|null} [hash] - raw value from provider data
 * @param {Object} [logger] - optional logger, called only when coercing
 * @returns {string|undefined} `"oprf-raw"`, or undefined when not hashing
 */
export function normalizeRedactionHash(hash, logger) {
  // No hash means "reveal this normally" — leave it alone.
  if (!hash) return undefined;
  if (hash === SUPPORTED_REDACTION_HASH) return SUPPORTED_REDACTION_HASH;

  logger?.warn?.(
    `[PROVIDER] Unsupported redaction hash ${JSON.stringify(hash)}; ` +
      `falling back to ${SUPPORTED_REDACTION_HASH}`,
    "background.claim",
  );
  return SUPPORTED_REDACTION_HASH;
}

/**
 * URL matching strategies, and how this SDK maps them.
 *
 * The upstream enum is `REGEX | CONSTANT | TEMPLATE` (InApp
 * `UrlType` in lib/src/data/providers.dart). Note what is NOT in it: `EXACT`.
 * That name is local to this SDK — it is what `matchesRequestCriteria` has always
 * defaulted to and what the background writes on synthetic requests — so it is
 * kept as an alias rather than removed.
 *
 *   CONSTANT | EXACT → compare the URL for equality
 *   TEMPLATE | REGEX → build a regex from the template and test it
 *
 * `CONSTANT` is the canonical value for a plain URL AND upstream's default: InApp
 * infers TEMPLATE when the url contains `{{` and CONSTANT otherwise. This SDK
 * used to return `false` for it, so a provider authored with the normal default
 * never matched any request at all — no claim, no proof, no diagnostic beyond
 * "request intercepted", and the session died on the timer.
 */
export const URL_TYPES = {
  CONSTANT: "CONSTANT",
  TEMPLATE: "TEMPLATE",
  REGEX: "REGEX",
};

/**
 * Resolve a requestData `urlType` to one of CONSTANT / TEMPLATE / REGEX.
 *
 * An absent or unrecognised value is INFERRED from the url the same way InApp
 * does, rather than being treated as unmatchable. That direction of failure is
 * deliberate: guessing wrong costs one non-matching request, whereas refusing to
 * match costs the whole verification.
 *
 * @param {string} [urlType]
 * @param {string} [url] - used to infer when urlType is absent/unknown
 * @param {{warn?: Function}} [logger]
 * @returns {"CONSTANT"|"TEMPLATE"|"REGEX"}
 */
export function normalizeUrlType(urlType, url, logger) {
  const raw = typeof urlType === "string" ? urlType.toUpperCase() : "";

  if (raw === URL_TYPES.CONSTANT || raw === "EXACT") return URL_TYPES.CONSTANT;
  if (raw === URL_TYPES.TEMPLATE) return URL_TYPES.TEMPLATE;
  if (raw === URL_TYPES.REGEX) return URL_TYPES.REGEX;

  const inferred =
    typeof url === "string" && url.includes("{{") ? URL_TYPES.TEMPLATE : URL_TYPES.CONSTANT;

  if (raw) {
    logger?.warn?.(
      `[PROVIDER] Unsupported urlType "${urlType}"; treating it as ${inferred}`,
      "provider.normalization",
    );
  }

  return inferred;
}
