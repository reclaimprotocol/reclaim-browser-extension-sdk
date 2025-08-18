// Import shared utility functions
import {
  getValueFromJsonPath,
  getValueFromXPath,
  isJsonFormat,
  safeJsonParse,
} from "./params-extractor-utils.js";
import { debugLogger, DebugLogType } from "../logger";

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
  // Check URL match

  // For exact match
  if (filterCriteria.url === request.url) {
    return true;
  }

  // For regex match
  if (filterCriteria.urlType === "REGEX") {
    const urlRegex = new RegExp(convertTemplateToRegex(filterCriteria.url, parameters).pattern);
    if (!urlRegex.test(request.url)) {
      return false;
    }
  }

  // For template match
  if (filterCriteria.urlType === "TEMPLATE") {
    const urlTemplate = new RegExp(convertTemplateToRegex(filterCriteria.url, parameters).pattern);
    if (!urlTemplate.test(request.url)) {
      return false;
    }
  }

  // Check method match
  if (request.method !== filterCriteria.method) {
    return false;
  }

  // Check body match if enabled
  if (filterCriteria.bodySniff && filterCriteria.bodySniff.enabled) {
    const bodyTemplate = filterCriteria.bodySniff.template;
    const requestBody =
      typeof request.body === "string" ? request.body : JSON.stringify(request.body);

    // For exact match
    if (bodyTemplate === requestBody) {
      return true;
    }

    // For template match
    const bodyRegex = new RegExp(convertTemplateToRegex(bodyTemplate, parameters).pattern);
    if (!bodyRegex.test(requestBody)) {
      return false;
    }
  }

  // If we get here, all criteria matched
  return true;
}

// Function to check if response matches criteria
function matchesResponseCriteria(responseText, matchCriteria, parameters = {}) {
  if (!matchCriteria || matchCriteria.length === 0) {
    return true;
  }

  for (const match of matchCriteria) {
    const { pattern } = convertTemplateToRegex(match.value, parameters);
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
function matchesResponseFields(responseText, responseRedactions) {
  if (!responseRedactions || responseRedactions.length === 0) {
    return true;
  }

  // Try to parse JSON if the response appears to be JSON
  let jsonData = null;
  const isJson = isJsonFormat(responseText);

  if (isJson) {
    jsonData = safeJsonParse(responseText);
    if (jsonData) {
    }
  }

  // Check each redaction pattern
  for (const redaction of responseRedactions) {
    // If jsonPath is specified and response is JSON
    if (redaction.jsonPath && jsonData) {
      try {
        const value = getValueFromJsonPath(jsonData, redaction.jsonPath);

        // If we get here but value is undefined, the path doesn't exist
        if (value === undefined || value === null) return false;
      } catch (error) {
        debugLogger.error(
          DebugLogType.CLAIM,
          `[NETWORK-FILTER] Error checking jsonPath ${redaction.jsonPath}:`,
          error,
        );
        return false;
      }
    }
    // If xPath is specified and response is not JSON (assumed to be HTML)
    else if (redaction.xPath && !isJson) {
      try {
        const value = getValueFromXPath(responseText, redaction.xPath);
        if (!value) return false;
      } catch (error) {
        debugLogger.error(
          DebugLogType.CLAIM,
          `[NETWORK-FILTER] Error checking xPath ${redaction.xPath}:`,
          error,
        );
        return false;
      }
    }
    // If regex is specified
    else if (redaction.regex) {
      try {
        const regex = new RegExp(redaction.regex);
        if (!regex.test(responseText)) return false;
      } catch (error) {
        debugLogger.error(
          DebugLogType.CLAIM,
          `[NETWORK-FILTER] Error checking regex ${redaction.regex}:`,
          error,
        );
        return false;
      }
    }
  }

  // All checks passed
  return true;
}

// Main filtering function
export const filterRequest = (request, filterCriteria, parameters = {}) => {
  try {
    // First check if request matches criteria
    if (!matchesRequestCriteria(request, filterCriteria, parameters)) {
      return false;
    }

    // Then check if response matches (if we have response data)
    if (request.responseText && filterCriteria.responseMatches) {
      if (
        !matchesResponseCriteria(request.responseText, filterCriteria.responseMatches, parameters)
      ) {
        return false;
      }
    }

    // Check if the response fields match the responseRedactions criteria
    if (request.responseText && filterCriteria.responseRedactions) {
      if (!matchesResponseFields(request.responseText, filterCriteria.responseRedactions)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    debugLogger.error(DebugLogType.CLAIM, "[NETWORK-FILTER] Error filtering request:", error);
    return false;
  }
};
