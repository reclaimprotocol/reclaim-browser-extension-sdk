// Import shared utility functions
import { isJsonFormat, jsonPathExists, safeJsonParse } from "./params-extractor-utils.js";
import { makeRegex } from "./make-regex.js";
// Dependency-free by design, so it is safe for the content bundle — see the
// "Keep them out of the content bundle" rule for the vendored parsers.
import { normalizeUrlType, URL_TYPES } from "../provider-normalization.js";

function escapeSpecialCharacters(input) {
  return input.replace(/[[\]()*+?.,\\^$|#]/g, "\\$&");
}

// Check that every field in `template` exists with an equal value in `actual`,
// ignoring any extra fields `actual` may have (sites routinely append new
// fields to a request payload over time). Arrays must match exactly.
function isJsonSubset(template, actual) {
  if (template === actual) return true;
  if (
    typeof template !== "object" ||
    typeof actual !== "object" ||
    template === null ||
    actual === null
  ) {
    return false;
  }
  if (Array.isArray(template) !== Array.isArray(actual)) return false;
  if (Array.isArray(template)) {
    return (
      template.length === actual.length &&
      template.every((item, i) => isJsonSubset(item, actual[i]))
    );
  }
  return Object.keys(template).every((key) => isJsonSubset(template[key], actual[key]));
}

function getTemplateVariables(template) {
  const paramRegex = /{{(\w+)}}/g;
  const variables = [];
  let match;

  while ((match = paramRegex.exec(template)) !== null) {
    variables.push(match[1]);
  }

  return variables;
}

export function convertTemplateToRegex(template, parameters = {}) {
  let escapedTemplate = escapeSpecialCharacters(template);

  const allVars = getTemplateVariables(template);
  const unsubstitutedVars = [];

  // Replace template variables with actual values or regex patterns
  for (const param of allVars) {
    if (parameters[param]) {
      // Substitute known parameter
      escapedTemplate = escapedTemplate.replace(`{{${param}}}`, parameters[param]);
    } else {
      // Track unsubstituted variables
      unsubstitutedVars.push(param);
      // Use appropriate regex pattern based on variable name
      const replacement = param.endsWith("GRD") ? "(.*)" : "(.*?)";
      escapedTemplate = escapedTemplate.replace(`{{${param}}}`, replacement);
    }
  }

  return {
    pattern: escapedTemplate,
    allVars,
    unsubstitutedVars,
  };
}

/**
 * The gate's stages, in the order they are evaluated.
 *
 * A rejected request is otherwise indistinguishable from a request that was
 * never made: everything that logs about extraction runs only *after* a match,
 * so a provider whose bodySniff template is stale fails on the session timer
 * looking exactly like "the user never logged in". Naming the stage a candidate
 * died at is the only signal that separates the two.
 *
 * Order matters — callers compare `MATCH_STAGE_ORDER.indexOf(stage)` to track
 * the furthest point any request reached against a given matcher.
 */
export const MATCH_STAGES = {
  URL: "url",
  METHOD: "method",
  BODY: "body",
  RESPONSE_MISSING: "responseMissing",
  RESPONSE_MATCH: "responseMatch",
  RESPONSE_REDACTION: "responseRedaction",
  MATCHED: "matched",
};

export const MATCH_STAGE_ORDER = [
  MATCH_STAGES.URL,
  MATCH_STAGES.METHOD,
  MATCH_STAGES.BODY,
  MATCH_STAGES.RESPONSE_MISSING,
  MATCH_STAGES.RESPONSE_MATCH,
  MATCH_STAGES.RESPONSE_REDACTION,
  MATCH_STAGES.MATCHED,
];

const matched = () => ({ matched: true, stage: MATCH_STAGES.MATCHED });
const rejected = (stage, detail) => ({ matched: false, stage, detail });

function describeRequestCriteria(request, filterCriteria, parameters = {}) {
  if (!filterCriteria || !request) {
    return rejected(MATCH_STAGES.URL, "no request or no criteria");
  }

  // 1) URL match: exact, REGEX, or TEMPLATE
  const { url, urlType } = filterCriteria;
  if (!url) return rejected(MATCH_STAGES.URL, "criteria carries no url");

  // CONSTANT is upstream's default and its name for a plain URL; EXACT is this
  // SDK's local alias for the same thing. An unknown value is inferred from the
  // url rather than left unmatchable — this branch used to `return false` for
  // everything it did not recognise, so a provider carrying the canonical
  // CONSTANT never matched a single request.
  const type = normalizeUrlType(urlType, url);

  const urlMatches =
    type === URL_TYPES.CONSTANT
      ? url === request.url
      : makeRegex(convertTemplateToRegex(url, parameters).pattern).test(request.url);

  if (!urlMatches) return rejected(MATCH_STAGES.URL, `${type} url did not match`);

  if (request.method?.toUpperCase() !== filterCriteria.method?.toUpperCase()) {
    return rejected(
      MATCH_STAGES.METHOD,
      `expected ${filterCriteria.method}, saw ${request.method}`,
    );
  }

  // 3) Body match (only if enabled)
  const sniff = filterCriteria.bodySniff;
  if (!sniff || !sniff.enabled) return matched();

  const bodyTemplate = sniff.template ?? "";
  const requestBody =
    typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});

  // exact body equality satisfies body criterion
  if (bodyTemplate === requestBody) return matched();

  // A literal (var-free) JSON template only needs to be a structural subset
  // of the real body — a strict string/regex match breaks the moment the
  // site appends a new field to the payload.
  if (
    getTemplateVariables(bodyTemplate).length === 0 &&
    isJsonFormat(bodyTemplate) &&
    isJsonFormat(requestBody)
  ) {
    const templateJson = safeJsonParse(bodyTemplate);
    const requestJson = safeJsonParse(requestBody);
    if (templateJson && requestJson && isJsonSubset(templateJson, requestJson)) {
      return matched();
    }
  }

  const { pattern } = convertTemplateToRegex(bodyTemplate, parameters);
  if (makeRegex(pattern).test(requestBody)) return matched();

  // The actual body is the user's request payload, so only its size travels in
  // the message. The template is provider-authored and is the thing worth
  // reading, but it can be long — callers pass it through the log payload.
  return rejected(
    MATCH_STAGES.BODY,
    `bodySniff template (${bodyTemplate.length} chars) did not match the request body (${requestBody.length} chars)`,
  );
}

function describeResponseCriteria(responseText, matchCriteria, parameters = {}) {
  if (!matchCriteria || matchCriteria.length === 0) {
    return matched();
  }

  for (let i = 0; i < matchCriteria.length; i++) {
    const match = matchCriteria[i];
    let pattern;
    if (match.type === "regex") {
      pattern = match.value;
    } else {
      pattern = convertTemplateToRegex(match.value, parameters).pattern;
    }
    const regex = makeRegex(pattern);
    const matches = regex.test(responseText);
    const matchExpectation = match.invert ? !matches : matches;
    if (!matchExpectation) {
      // `match.value` is provider-authored (a template with {{param}}
      // placeholders), so it is safe in the message; the response is not, and
      // only its size appears.
      return rejected(
        MATCH_STAGES.RESPONSE_MATCH,
        `responseMatch #${i} ${match.invert ? "(inverted) " : ""}"${match.value}" not satisfied by the response (${responseText.length} chars)`,
      );
    }
  }

  return matched();
}

// Cheap pre-gate over responseRedactions.
//
// This is only a presence check — it produces no values. Authoritative
// resolution (the attestor's xPath -> jsonPath -> regex chain) runs in the
// background via ../claim-creator/attestor-extraction.js, which is where the
// parsers live.
//
// Notably there is no xPath branch. There used to be, backed by a
// regex-on-tag-name stand-in that could not evaluate most real XPath
// expressions, so it rejected pages the attestor would have accepted. A
// faithful xPath check needs xpath+parse5, and this module is bundled into a
// content script injected at document_start on every page of every site — so
// xPath is deferred to the background rather than approximated here.
function describeResponseFields(responseText, responseRedactions, logger) {
  if (!responseRedactions || responseRedactions.length === 0) {
    return matched();
  }

  const reject = (detail) => rejected(MATCH_STAGES.RESPONSE_REDACTION, detail);

  for (let i = 0; i < responseRedactions.length; i++) {
    const redaction = responseRedactions[i];
    // An xPath-only redaction can't be pre-checked cheaply; let the background
    // decide rather than guess.
    if (redaction.xPath && !redaction.jsonPath && !redaction.regex) {
      continue;
    }

    // jsonPath is only meaningful once an xPath has narrowed to a JSON island;
    // when there's an xPath in play, defer the whole redaction.
    if (redaction.jsonPath && !redaction.xPath) {
      if (!isJsonFormat(responseText)) {
        return reject(
          `redaction #${i} needs jsonPath ${redaction.jsonPath} but the response is not JSON (${responseText.length} chars)`,
        );
      }
      if (!jsonPathExists(responseText, redaction.jsonPath)) {
        return reject(`redaction #${i} jsonPath ${redaction.jsonPath} is absent from the response`);
      }
      continue;
    }

    // A regex nested under an xPath applies to the selected element, not the
    // whole body, so it can't be tested here either.
    if (redaction.regex && !redaction.xPath) {
      try {
        if (!makeRegex(redaction.regex).test(responseText)) {
          return reject(`redaction #${i} regex ${redaction.regex} did not match the response`);
        }
      } catch (error) {
        logger?.error?.(
          `[NETWORK-FILTER] Error checking regex ${redaction.regex}: ${error?.message}`,
          "content.filter",
        );
        return reject(`redaction #${i} regex ${redaction.regex} is invalid: ${error?.message}`);
      }
    }
  }

  // All checks passed
  return matched();
}

/**
 * The gate, with a reason attached.
 *
 * @returns {{matched: boolean, stage: string, detail?: string}} `stage` is the
 *  point evaluation stopped — `MATCH_STAGES.MATCHED` on success, otherwise the
 *  check that rejected the request. `detail` never carries response or request
 *  bodies, only provider-authored patterns and sizes: it becomes a log line,
 *  and log lines are not redacted.
 */
export const describeRequestMatch = (request, filterCriteria, parameters = {}, logger) => {
  try {
    // First check if request matches criteria
    const requestVerdict = describeRequestCriteria(request, filterCriteria, parameters);
    if (!requestVerdict.matched) return requestVerdict;

    // If criteria requires response validation but we have no response, reject
    const needsResponse =
      filterCriteria.responseMatches?.length > 0 || filterCriteria.responseRedactions?.length > 0;
    if (needsResponse && !request.responseText) {
      // Routine rather than fatal: the content script pairs a request with its
      // response asynchronously, so this is the normal state on the tick
      // between the two.
      return rejected(MATCH_STAGES.RESPONSE_MISSING, "no response body paired with this request");
    }

    if (filterCriteria.responseMatches && filterCriteria.responseMatches.length > 0) {
      const responseVerdict = describeResponseCriteria(
        request.responseText,
        filterCriteria.responseMatches,
        parameters,
      );
      if (!responseVerdict.matched) return responseVerdict;
    }

    if (filterCriteria.responseRedactions && filterCriteria.responseRedactions.length > 0) {
      const fieldsVerdict = describeResponseFields(
        request.responseText,
        filterCriteria.responseRedactions,
        logger,
      );
      if (!fieldsVerdict.matched) return fieldsVerdict;
    }

    return matched();
  } catch (error) {
    logger?.error?.(
      "[NETWORK-FILTER] Error filtering request: " + error?.message,
      "content.filter",
    );
    return rejected(MATCH_STAGES.URL, `threw: ${error?.message}`);
  }
};

// Main filtering function
export const filterRequest = (request, filterCriteria, parameters = {}, logger) =>
  describeRequestMatch(request, filterCriteria, parameters, logger).matched;

//tryWithNonce/tryWithTT/tryPlain
