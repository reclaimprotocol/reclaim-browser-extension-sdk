/**
 * Client source — the SDK's self-identification string.
 *
 * One string, two consumers:
 *  - the `reclaim-api-client` header on every request the SDK makes
 *  - the `source` field on every log batch AND every individual log entry
 *
 * The grammar mirrors the InApp SDK's `getClientSource()`
 * (reclaim-inapp-sdk/lib/src/services/source/source.dart):
 *
 *     <sdk-name> sdk/v<sdk-version> (<platform>,<consumer>/v<consumer-version>)
 *
 *   InApp: verifier-app sdk/v0.43.0 operator/v3.5.0 (ios,org.reclaimprotocol.app/v1.50.1+816)
 *   Ours:  browser-extension-sdk sdk/v0.4.2 (chrome/141,ldbfjimhpnpkeanmnfkkbdhllcmjjhpp/v1.0.0)
 *
 * Two deliberate differences from InApp:
 *  - No `operator/` clause. The extension has no TEE operator package to report;
 *    emitting `operator/unknown` would be noise, not information.
 *  - InApp's builder is async (`PackageInfo.fromPlatform()` is a platform
 *    channel). Every input here is synchronous — `chrome.runtime.getManifest()`
 *    and `navigator.userAgentData.brands` both return immediately — so this is a
 *    plain memoized function. That matters: an async source would leave the
 *    earliest logs of a session, the ones that explain a startup failure,
 *    stamped with a placeholder.
 *
 * The team's identification rule is a substring check, and every string this
 * module can produce contains `browser-extension-sdk` — including the
 * degraded-environment fallbacks.
 */

export const SDK_NAME = "browser-extension-sdk";

// DefinePlugin substitutes this in all three webpack configs. The `typeof`
// guard keeps the module importable under Node for tests, where it is absent.
// eslint-disable-next-line no-undef
const SDK_VERSION = typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "unknown";

/** Header name InApp/Verifier already send on every request. */
export const CLIENT_SOURCE_HEADER = "reclaim-api-client";

// Ordered longest-alias-first: Edge and Opera user agents also contain
// "Chrome/", and Safari's contains "Version/" before "Safari/".
const UA_PATTERNS = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, "edge"],
  [/\bOPR\/(\d+)/, "opera"],
  [/\bFirefox\/(\d+)/, "firefox"],
  [/\bChrome\/(\d+)/, "chrome"],
  [/\bVersion\/(\d+)[^ ]* Safari\//, "safari"],
];

/**
 * Sanitize an atomic component — a brand name, a version, an extension ID.
 *
 * The grammar's separators are space, comma, slash and parens, so none of them
 * may appear inside a component. Use `field()` instead for a value that is
 * already `name/version` and legitimately contains a slash.
 */
function token(value, fallback = "unknown") {
  const cleaned = String(value ?? "")
    .replace(/[\s(),/]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

/**
 * Sanitize a composed `name/version` value. Same as `token()` but keeps the
 * slash, which is a separator *within* the field rather than between fields.
 */
function field(value, fallback = "unknown") {
  const cleaned = String(value ?? "")
    .replace(/[\s(),]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

/**
 * Browser name and major version, e.g. "chrome/141".
 *
 * `navigator.userAgentData` is available in service workers and is preferred
 * because Chrome freezes the legacy UA string. `brands` is sync; only
 * `getHighEntropyValues()` is async, and we don't need it.
 */
function detectPlatform() {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (!nav) return "unknown";

  const brands = nav.userAgentData?.brands;
  if (Array.isArray(brands)) {
    // Chrome pads `brands` with a deliberately garbled entry ("Not.A/Brand",
    // ";Not A Brand", …) to break naive UA parsing. Skip it.
    const brand = brands.find((b) => b?.brand && !/not[^a-z]*a[^a-z]*brand/i.test(b.brand));
    if (brand) return `${token(brand.brand.toLowerCase())}/${token(brand.version)}`;
  }

  const ua = nav.userAgent || "";
  for (const [pattern, name] of UA_PATTERNS) {
    const match = pattern.exec(ua);
    if (match) return `${name}/${match[1]}`;
  }
  return "unknown";
}

/**
 * The consumer this SDK is embedded in.
 *
 * In an extension context that is the host extension: its ID is the closest
 * analogue of InApp's package identifier — stable, unique per published
 * extension, and free of characters that would break the grammar. The manifest
 * `name` is not used: it is user-facing, localizable, and full of spaces.
 *
 * In web-page mode there is no manifest, so there is nothing to report; the
 * clause degrades to "web" rather than inventing an identity.
 */
function detectConsumer() {
  try {
    const manifest = globalThis.chrome?.runtime?.getManifest?.();
    if (manifest) {
      const id = token(globalThis.chrome?.runtime?.id, "unpacked");
      return `${id}/v${token(manifest.version)}`;
    }
  } catch {
    // Not an extension context, or the API is unavailable.
  }
  return "web";
}

/**
 * Assemble the string. Pure and exported so the grammar itself is testable
 * without a browser.
 *
 * @param {Object} parts
 * @param {string} parts.sdkVersion - bare version, no leading "v"
 * @param {string} parts.platform - e.g. "chrome/141"
 * @param {string} parts.consumer - e.g. "<ext-id>/v1.0.0" or "web"
 * @returns {string}
 */
export function buildClientSource({ sdkVersion, platform, consumer }) {
  return `${SDK_NAME} sdk/v${token(sdkVersion)} (${field(platform)},${field(consumer)})`;
}

let cached = null;

/**
 * Memoized client source for this context.
 *
 * Cached per JS realm, so a service-worker restart rebuilds it — which is
 * correct, since a browser update between restarts should be reflected.
 *
 * @returns {string}
 */
export function getClientSource() {
  if (cached === null) {
    try {
      cached = buildClientSource({
        sdkVersion: SDK_VERSION,
        platform: detectPlatform(),
        consumer: detectConsumer(),
      });
    } catch {
      // Never let identification break a request or a log.
      cached = `${SDK_NAME} sdk/v${token(SDK_VERSION)} (unknown,unknown)`;
    }
  }
  return cached;
}

/** Test seam — drops the memoized value. */
export function resetClientSourceCache() {
  cached = null;
}

/**
 * Merge the `reclaim-api-client` header into a headers object.
 *
 * Every outbound request from the SDK goes through this so extension traffic is
 * attributable server-side. Note this is identification only: per the team's
 * guideline the extension contributes no device information to analytics.
 *
 * @param {Object} [headers]
 * @returns {Object}
 */
export function withClientSource(headers = {}) {
  return { ...headers, [CLIENT_SOURCE_HEADER]: getClientSource() };
}
