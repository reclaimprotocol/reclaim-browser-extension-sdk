// Import shared utility functions
import {
  getValueFromJsonPath,
  getValueFromXPath,
  isJsonFormat,
  safeJsonParse,
} from "./params-extractor-utils.js";
import { LOG_LEVEL, LOG_TYPES, EVENT_TYPES } from "../logger";

// Escape special regex characters in string
function escapeSpecialCharacters(input) {
  return input.replace(/[[\]()*+?.,\\^$|#]/g, "\\$&");
}

// Extract template variables from a string
function getTemplateVariables(template) {
  const paramRegex = /{{(\w+)}}/g;
  const variables = [];
  let match;

  while ((match = paramRegex.exec(template)) !== null) {
    variables.push(match[1]);
  }

  return variables;
}

// Convert template to regex, substituting known parameters
export function convertTemplateToRegex(template, parameters = {}) {
  // Escape special regex characters
  let escapedTemplate = escapeSpecialCharacters(template);

  // Find all template variables
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

// Function to check if a request matches filtering criteria
function matchesRequestCriteria(request, filterCriteria, parameters = {}) {
  if (!filterCriteria || !request) return false;

  // 1) URL match: exact, REGEX, or TEMPLATE
  const urlMatches = (() => {
    const { url, urlType } = filterCriteria;
    if (!url) return false;

    const type = (urlType || "EXACT").toUpperCase();

    if (type === "EXACT") {
      return url === request.url;
    }

    if (type === "REGEX" || type === "TEMPLATE") {
      const { pattern } = convertTemplateToRegex(url, parameters);

      return new RegExp(pattern).test(request.url);
    }

    return false;
  })();

  if (!urlMatches) return false;
  if (request.method?.toUpperCase() !== filterCriteria.method?.toUpperCase()) {
    return false;
  }

  // 3) Body match (only if enabled)
  const bodyMatches = (() => {
    const sniff = filterCriteria.bodySniff;
    if (!sniff || !sniff.enabled) return true;
    const bodyTemplate = sniff.template ?? "";
    const requestBody =
      typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});

    // exact body equality satisfies body criterion
    if (bodyTemplate === requestBody) return true;

    // template/regex body match
    const { pattern } = convertTemplateToRegex(bodyTemplate, parameters);
    return new RegExp(pattern).test(requestBody);
  })();

  return bodyMatches;
}

// Function to check if response matches criteria
function matchesResponseCriteria(responseText, matchCriteria, parameters = {}) {
  if (!matchCriteria || matchCriteria.length === 0) {
    return true;
  }

  for (const match of matchCriteria) {
    let pattern;
    if (match.type === "regex") {
      pattern = match.value;
    } else {
      pattern = convertTemplateToRegex(match.value, parameters).pattern;
    }
    const regex = new RegExp(pattern);
    const matches = regex.test(responseText);
    // Check if match expectation is met
    const matchExpectation = match.invert ? !matches : matches;
    if (!matchExpectation) {
      return false;
    }
  }

  return true;
}

// Function to check if response fields match responseRedactions criteria
function matchesResponseFields(responseText, responseRedactions, contentLogger) {
  if (!responseRedactions || responseRedactions.length === 0) {
    return true;
  }

  // Try to parse JSON if the response appears to be JSON
  let jsonData = null;
  const isJson = isJsonFormat(responseText);

  if (isJson) {
    jsonData = safeJsonParse(responseText);
  }

  // Check each redaction pattern
  for (const redaction of responseRedactions) {
    // If jsonPath is specified and response is JSON
    if (redaction.jsonPath && jsonData) {
      try {
        const value = getValueFromJsonPath(jsonData, redaction.jsonPath);
        // If we get here but value is undefined, the path doesn't exist
        if (value === undefined) return false;
      } catch (error) {
        contentLogger.error({
          message: `[NETWORK-FILTER] Error checking jsonPath ${redaction.jsonPath}:`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.CONTENT,
          eventType: EVENT_TYPES.JSON_PATH_MATCH_REQUIREMENT_FAILED,
        });
        return false;
      }
    }
    // If xPath is specified and response is not JSON (assumed to be HTML)
    else if (redaction.xPath && !isJson) {
      try {
        const value = getValueFromXPath(responseText, redaction.xPath);
        if (!value) return false;
      } catch (error) {
        contentLogger.error({
          message: `[NETWORK-FILTER] Error checking xPath ${redaction.xPath}:`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.CONTENT,
          eventType: EVENT_TYPES.X_PATH_MATCH_REQUIREMENT_FAILED,
        });
        return false;
      }
    }
    // If regex is specified
    else if (redaction.regex) {
      try {
        const regex = new RegExp(redaction.regex);
        if (!regex.test(responseText)) return false;
      } catch (error) {
        contentLogger.error({
          message: `[NETWORK-FILTER] Error checking regex ${redaction.regex}:`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.CONTENT,
          eventType: EVENT_TYPES.REGEX_MATCH_REQUIREMENT_FAILED,
        });
        return false;
      }
    }
  }

  // All checks passed
  return true;
}

// Main filtering function
export const filterRequest = (request, filterCriteria, parameters = {}, contentLogger) => {
  try {
    // First check if request matches criteria
    if (!matchesRequestCriteria(request, filterCriteria, parameters)) {
      return false;
    }

    // Then check if response matches (if we have response data)
    if (
      request.responseText &&
      filterCriteria.responseMatches &&
      !matchesResponseCriteria(request.responseText, filterCriteria.responseMatches, parameters)
    ) {
      return false;
    }

    // Check if the response fields match the responseRedactions criteria
    if (
      request.responseText &&
      filterCriteria.responseRedactions &&
      !matchesResponseFields(request.responseText, filterCriteria.responseRedactions, contentLogger)
    ) {
      return false;
    }

    return true;
  } catch (error) {
    contentLogger.error({
      message: "[NETWORK-FILTER] Error filtering request:",
      logLevel: LOG_LEVEL.ERROR,
      type: LOG_TYPES.CONTENT,
      eventType: EVENT_TYPES.FILTER_REQUEST_ERROR,
      meta: { error },
    });
    return false;
  }
};
