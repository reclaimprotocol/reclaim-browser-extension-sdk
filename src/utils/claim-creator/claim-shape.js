/**
 * Shape gate for the claim handed to the attestor.
 *
 * `params` and `secretParams` are validated server-side by AJV against
 * attestor-core's `HttpProviderParameters` / `HttpProviderSecretParameters`
 * schemas (see `server/utils/validation.ts`). Both are
 * `additionalProperties: false` and AJV runs with `strict: true` and no
 * `removeAdditional`, so a single unexpected key fails the entire claim with
 * `ERROR_BAD_REQUEST: Params validation failed` — at proof time, after the user
 * has logged into the provider, and with the offending field named only inside
 * an opaque errors blob.
 *
 * Provider documents legitimately carry fields this SDK must not forward
 * (`order`, `description`, `isOptional`, the legacy `responseSelections`), and
 * that set grows independently of this SDK. So the gate is an allowlist taken
 * from the schema rather than a denylist of known-bad keys.
 *
 * Kept in its own module with no imports so it is unit-testable: claim-creator.js
 * pulls in chrome.* and the offscreen document and cannot load under Node.
 */

/**
 * Keys the attestor's `HttpProviderParameters` schema declares. Mirrored by
 * hand from attestor-core `src/types/providers.gen.ts`; the schema is
 * `additionalProperties: false`, so this list is exhaustive by definition.
 * Re-sync alongside the vendored extraction code.
 */
const ALLOWED_PARAM_KEYS = new Set([
  "url",
  "method",
  "geoLocation",
  "proxySessionId",
  "headers",
  "body",
  "writeRedactionMode",
  "additionalClientOptions",
  "responseMatches",
  "responseRedactions",
  "paramValues",
]);

/** Keys the attestor's `HttpProviderSecretParameters` schema declares. */
const ALLOWED_SECRET_PARAM_KEYS = new Set([
  "cookieStr",
  "authorisationHeader",
  "headers",
  "paramValues",
]);

/**
 * Strip anything the attestor's schema would reject, coerce paramValues to
 * strings, and shout about required fields that are missing.
 *
 * Mutates in place — the caller has already assembled the objects, and a copy
 * would just have to be threaded through the claim construction below.
 *
 * @param {Object} params
 * @param {Object} secretParams
 * @param {Object} loggingHub
 */
export function assertClaimShape(params, secretParams, loggingHub) {
  for (const [target, allowed, label] of [
    [params, ALLOWED_PARAM_KEYS, "params"],
    [secretParams, ALLOWED_SECRET_PARAM_KEYS, "secretParams"],
  ]) {
    const stray = Object.keys(target).filter((key) => !allowed.has(key));
    if (stray.length) {
      // Stripped rather than thrown: dropping an unknown field still produces
      // a claim the attestor accepts, whereas failing the session would deny a
      // verification over a field the attestor was going to ignore anyway.
      for (const key of stray) delete target[key];
      loggingHub?.error?.(
        `[CLAIM-CREATOR] Stripped ${label} field(s) the attestor schema rejects: ${stray.join(", ")}`,
        "claim.creation",
      );
    }

    // Schema types paramValues as string→string. A customInjection can put a
    // number or boolean here via window.Reclaim, which AJV rejects.
    if (target.paramValues) {
      for (const [key, value] of Object.entries(target.paramValues)) {
        if (typeof value !== "string") {
          loggingHub?.warn?.(
            `[CLAIM-CREATOR] Coerced non-string ${label}.paramValues.${key} (${typeof value})`,
            "claim.creation",
          );
          target.paramValues[key] = value === null || value === undefined ? "" : String(value);
        }
      }
    }
  }

  // url, method and responseMatches are `required` in the schema.
  const missing = ["url", "method", "responseMatches"].filter((key) => !params[key]);
  if (missing.length) {
    loggingHub?.error?.(
      `[CLAIM-CREATOR] Claim params missing required field(s): ${missing.join(", ")}`,
      "claim.creation",
    );
  }
}
