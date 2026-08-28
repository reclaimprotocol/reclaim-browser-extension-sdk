// Utility functions for parameter extraction from various sources
import { convertTemplateToRegex } from "./network-filter.js";
import {
  makeRegex,
  resolveRedaction,
  describeRedaction,
  RedactionResolveError,
} from "./attestor-extraction.js";
// .js extension required: Node's ESM loader does not resolve extensionless
// relative paths, and this module is unit-tested (see CLAUDE.md).
import { EVENT_TYPES } from "../logger/constants.js";

/**
 * Extract dynamic parameters from a string by matching {{PARAM_NAME}} patterns
 * @param {string} text - Text to extract parameters from
 * @returns {string[]} Array of parameter names without braces
 */
export const extractDynamicParamNames = (text) => {
  if (!text) return [];
  const matches = text.match(/{{([^}]+)}}/g) || [];
  return matches.map((match) => match.substring(2, match.length - 2));
};

/**
 * `convertTemplateToRegex` substitutes each placeholder with a lazy `(.*?)`,
 * which is right for a boolean match but wrong for extraction: a placeholder at
 * the very end of a template has nothing after it to force the lazy group to
 * expand, so it captures the empty string. Anchoring with `$` in that case (and
 * only that case) makes the final group consume the remainder.
 *
 * Templates that don't end in a placeholder are left untouched, so a URL
 * carrying extra query params the template doesn't describe still matches.
 */
const anchorTrailingPlaceholder = (template, pattern) =>
  template.trimEnd().endsWith("}}") ? `${pattern}$` : pattern;

/**
 * Extract parameter values from URL using template matching
 * @param {string} urlTemplate - URL template with {{param}} placeholders
 * @param {string} actualUrl - Actual URL with values
 * @param {Object} paramValues - Object to store extracted parameter values
 * @returns {Object} Updated paramValues object
 */
export const extractParamsFromUrl = (urlTemplate, actualUrl, paramValues = {}) => {
  if (!urlTemplate || !actualUrl) return paramValues;

  const paramNames = extractDynamicParamNames(urlTemplate);
  const pattern = anchorTrailingPlaceholder(
    urlTemplate,
    convertTemplateToRegex(urlTemplate, paramNames).pattern,
  );

  // Match actual URL against the pattern. `.exec` rather than
  // `String.match`: makeRegex sets the `g` flag (to mirror the attestor's
  // flags) and `String.match` with `g` returns full matches, not groups.
  const match = makeRegex(pattern).exec(actualUrl);
  if (match && match.length > 1) {
    // Start from index 1 to skip the full match
    for (let i = 0; i < paramNames.length; i++) {
      if (match[i + 1] !== undefined) {
        paramValues[paramNames[i]] = match[i + 1];
      }
    }
  }
  return paramValues;
};

/**
 * Extract parameter values from request body using template matching
 * @param {string} bodyTemplate - Body template with {{param}} placeholders
 * @param {string} actualBody - Actual request body with values
 * @param {Object} paramValues - Object to store extracted parameter values
 * @returns {Object} Updated paramValues object
 */
export const extractParamsFromBody = (bodyTemplate, actualBody, paramValues = {}) => {
  if (!bodyTemplate || !actualBody) return paramValues;

  const paramNames = extractDynamicParamNames(bodyTemplate);

  const pattern = anchorTrailingPlaceholder(
    bodyTemplate,
    convertTemplateToRegex(bodyTemplate, {}).pattern,
  );

  // `.exec` rather than `String.match` — see extractParamsFromUrl.
  const match = makeRegex(pattern).exec(actualBody);
  if (match && match.length > 1) {
    // Start from index 1 to skip the full match
    for (let i = 0; i < paramNames.length; i++) {
      if (match[i + 1] !== undefined) {
        paramValues[paramNames[i]] = match[i + 1];
      }
    }
  }

  return paramValues;
};

// Regex specials to escape in a `contains` template. Braces are deliberately
// excluded so `{{param}}` placeholders survive escaping and can be substituted
// afterwards.
const REGEX_SPECIALS = /[.*+?^$()|[\]\\]/g;

// A named capture group must be a valid JS identifier.
const VALID_GROUP_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const escapeRegexLiterals = (input) => input.replace(REGEX_SPECIALS, "\\$&");

/**
 * Turn a responseMatch value into a regex with one capture group per
 * `{{param}}` placeholder. This is `substituteParamValues` (attestor-core
 * src/providers/http/index.ts) run backwards: whatever this pulls out is what
 * the attestor will substitute back in and re-assert against the response, so
 * the value has to come from the raw response bytes, unmodified.
 *
 * Named groups are used when every param name is a valid JS identifier, which
 * keeps the mapping obvious. Names that aren't (`{{user-id}}`, `{{2fa}}`) fall
 * back to positional groups mapped by placeholder order — a named group with
 * such a name is a regex syntax error, and dropping those params would be a
 * regression.
 *
 * @param {string} matchValue
 * @param {string} type - "regex" leaves the value as a regex; anything else
 *  ("contains", the default) treats it as a literal.
 * @param {string[]} paramNames
 * @returns {{regex: RegExp, named: boolean}|null}
 */
const buildTemplateRegex = (matchValue, type, paramNames) => {
  const named = paramNames.every((name) => VALID_GROUP_NAME.test(name));

  let pattern = type === "regex" ? matchValue : escapeRegexLiterals(matchValue);

  for (const name of paramNames) {
    const placeholder = `{{${name}}}`;
    let seen = false;
    while (pattern.includes(placeholder)) {
      // First occurrence captures; a repeat becomes a backreference, since a
      // duplicated group name is a syntax error. Positional mode can't express
      // a backreference by name, so a repeat just captures again — harmless,
      // because the values are read back by placeholder order.
      const replacement = named ? (seen ? `\\k<${name}>` : `(?<${name}>.*?)`) : "(.*?)";
      pattern = pattern.replace(placeholder, replacement);
      seen = true;
    }
  }

  try {
    return { regex: makeRegex(pattern), named };
  } catch {
    return null;
  }
};

/**
 * Extract parameter values from response text using responseMatches and
 * responseRedactions.
 *
 * Resolution follows the attestor's chain (xPath -> jsonPath -> regex, see
 * ./attestor-extraction.js) and the value is taken from the raw response slice,
 * never from a re-serialized JS value — a re-serialized object differs from the
 * response bytes in key order, spacing and escaping, and the attestor then
 * rejects the claim.
 *
 * @param {string} responseText - Response body text
 * @param {Array} responseMatches - Array of response match objects
 * @param {Array} responseRedactions - Array of response redaction objects
 * @param {Object} paramValues - Object to store extracted parameter values.
 *  Params already present here are treated as satisfied, so a redaction that
 *  can't resolve for an already-known param (e.g. supplied by a custom
 *  injection) is not fatal.
 * @param {Object} [logger] - optional logger
 * @returns {Object} Updated paramValues object
 * @throws {RedactionResolveError} if a redaction for an unknown param does not
 *  resolve against this response — the caller should keep looking rather than
 *  fail the session.
 */
export const extractParamsFromResponse = (
  responseText,
  responseMatches,
  responseRedactions,
  paramValues = {},
  logger,
) => {
  if (!responseText || !responseMatches?.length) return paramValues;

  logger?.info?.(
    `[PARAM-EXTRACTOR] Validating ${responseMatches.length} response match(es)`,
    "claim.params",
    { eventType: EVENT_TYPES.VALIDATING_CLAIM_PARAMETERS },
  );

  for (let i = 0; i < responseMatches.length; i++) {
    const match = responseMatches[i];
    if (!match?.value) continue;

    const paramNames = extractDynamicParamNames(match.value);
    if (paramNames.length === 0) continue;

    // Params already known (custom injection, URL/body template) don't need to
    // be re-derived, and must not make an unresolvable redaction fatal.
    const alreadyKnown = paramNames.every((name) => paramValues[name] !== undefined);

    // responseRedactions is index-correlated with responseMatches.
    const redaction = responseRedactions?.[i];

    let slices = [];
    if (redaction && (redaction.xPath || redaction.jsonPath || redaction.regex)) {
      try {
        slices = resolveRedaction(responseText, redaction).map((entry) => entry.value);

        // The success half of the chain. Until this existed, only *failures*
        // were reported (reportExtractionFailure in the background), so a
        // selector that resolved to the wrong region — or to an empty string —
        // was indistinguishable from one that was never evaluated. Selector
        // text is provider-authored; the resolved content is the user's, so
        // only its shape appears here and the values themselves ride the
        // payload, which is blanked at INFO and raw at FINE.
        logger?.info?.(
          `[PARAM-EXTRACTOR] Redaction #${i} resolved via ${describeRedaction(redaction)} → ${slices.length} slice(s) [${slices
            .map((slice) => `len=${String(slice ?? "").length}`)
            .join(", ")}]`,
          "claim.params",
          { payload: { extractedParameters: slices } },
        );
      } catch (error) {
        if (alreadyKnown) {
          logger?.debug?.(
            `[PARAM-EXTRACTOR] Redaction for already-known param(s) ${paramNames.join(", ")} did not resolve: ${error.message}`,
            "claim.params",
          );
          continue;
        }
        throw error;
      }
    }

    // Names and lengths only — see the note on the redaction line above.
    const reportResolved = (via, values) =>
      logger?.info?.(
        `[PARAM-EXTRACTOR] responseMatch #${i} resolved via ${via}: ${Object.entries(values)
          .map(([name, value]) => `${name}(len=${String(value ?? "").length})`)
          .join(", ")}`,
        "claim.params",
        { payload: { extractedParameters: values } },
      );

    // A hashed redaction reveals only its capture group, so that slice *is* the
    // value — there is no surrounding text to match a template against.
    if (redaction?.hash && paramNames.length === 1 && slices.length) {
      paramValues[paramNames[0]] = slices[0];
      reportResolved(`hashed redaction (${redaction.hash})`, { [paramNames[0]]: slices[0] });
      continue;
    }

    // A template that is nothing but a single placeholder has no surrounding
    // text to anchor a match against, so the resolved slice is the value.
    if (paramNames.length === 1 && match.value.trim() === `{{${paramNames[0]}}}` && slices.length) {
      paramValues[paramNames[0]] = slices[0];
      reportResolved("the resolved slice", { [paramNames[0]]: slices[0] });
      continue;
    }

    const built = buildTemplateRegex(match.value, match.type, paramNames);
    if (!built) {
      if (alreadyKnown) continue;
      throw new RedactionResolveError(
        `Could not build an extraction regex for responseMatch "${match.value}"`,
        { stage: "responseMatch" },
      );
    }

    // Prefer the revealed slice — it guarantees the value came from the region
    // the attestor reveals. Fall back to the full body, since providers often
    // author responseMatches against the whole response while the redaction
    // only narrows the reveal.
    const found = firstTemplateMatch(built, [...slices, responseText], paramNames);

    if (!found) {
      if (alreadyKnown) continue;
      throw new RedactionResolveError(
        `responseMatch "${match.value}" did not match the resolved response region`,
        { stage: "responseMatch" },
      );
    }

    Object.assign(paramValues, found);
    reportResolved(`template "${match.value}"`, found);
  }

  // Confirms the chain actually produced values, and how long each is. The
  // VALUES are deliberately absent from the message: this is the user's
  // extracted data, and a length is enough to tell "matched but empty" from
  // "matched correctly", which is the question this line exists to answer. INFO
  // rather than FINE because a wrong-but-plausible extraction is otherwise
  // invisible until the attestor rejects the claim minutes later.
  logger?.info?.(
    `[PARAM-EXTRACTOR] Resolved ${Object.keys(paramValues).length} param(s): ${Object.entries(
      paramValues,
    )
      .map(([name, value]) => `${name}(len=${String(value ?? "").length})`)
      .join(", ")}`,
    "claim.params",
    { payload: { extractedParameters: paramValues } },
  );

  return paramValues;
};

/**
 * Run the built regex against each haystack in turn, returning the first match
 * that yields a value for every requested param.
 *
 * @param {{regex: RegExp, named: boolean}} built
 * @param {string[]} haystacks
 * @param {string[]} paramNames
 * @returns {Object|null} param name -> value
 */
const firstTemplateMatch = ({ regex, named }, haystacks, paramNames) => {
  for (const haystack of haystacks) {
    if (typeof haystack !== "string" || !haystack) continue;

    // makeRegex sets `g`, so lastIndex carries over between calls.
    regex.lastIndex = 0;
    const result = regex.exec(haystack);
    if (!result) continue;

    const values = {};
    let complete = true;
    for (let i = 0; i < paramNames.length; i++) {
      const name = paramNames[i];
      // Positional groups are ordered by placeholder, hence index + 1.
      const value = named ? result.groups?.[name] : result[i + 1];
      if (value === undefined) {
        complete = false;
        break;
      }
      values[name] = value;
    }
    // A partial match against the narrow slice can still match fully against
    // the full body, so keep going rather than giving up here.
    if (complete) return values;
  }
  return null;
};

/**
 * Names of params whose responseRedaction has a hash set (oprf, etc.) — these
 * must be routed to secretParams regardless of naming, since a hashed
 * redaction signals the provider wants this value kept out of the public
 * claim, and extractParamsFromResponse extracts it independently of hash.
 * @param {Array} responseMatches
 * @param {Array} responseRedactions
 * @returns {Set<string>}
 */
/**
 * NOTE: do NOT use this to force params into `secretParams`. Doing so breaks
 * OPRF — see the long comment at the separateParams call site in
 * claim-creator.js. Kept because knowing which params are hashed is useful for
 * diagnostics.
 */
export const getHashedParamNames = (responseMatches, responseRedactions) => {
  const hashed = new Set();
  if (!responseMatches || !responseRedactions) return hashed;

  for (let i = 0; i < responseMatches.length; i++) {
    const match = responseMatches[i];
    const redaction = responseRedactions[i];
    if (!match?.value || !redaction?.hash) continue;

    const paramNames = extractDynamicParamNames(match.value);
    if (paramNames.length > 0) hashed.add(paramNames[0]);
  }

  return hashed;
};

/**
 * Separate parameters into public and secret based on names
 * @param {Object} paramValues - All parameter values
 * @param {Set<string>|string[]} [forceSecretNames] - Names to always treat as secret (e.g. from getHashedParamNames)
 * @returns {Object} Object with publicParams and secretParams
 */
export const separateParams = (paramValues, forceSecretNames) => {
  const publicParams = {};
  const secretParams = {};
  const forceSecret =
    forceSecretNames instanceof Set ? forceSecretNames : new Set(forceSecretNames || []);

  Object.entries(paramValues || {}).forEach(([key, value]) => {
    if (key.toLowerCase().includes("secret") || forceSecret.has(key)) {
      secretParams[key] = value;
    } else {
      publicParams[key] = value;
    }
  });

  return { publicParams, secretParams };
};
