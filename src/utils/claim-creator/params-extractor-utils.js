/**
 * Utility functions for extracting values from JSON and HTML responses
 * Shared between network-filter.js and params-extractor.js
 */

import { debugLogger, DebugLogType } from "../logger";

/**
 * Extract values from JSON response using jsonPath
 * @param {Object} jsonData - Parsed JSON response
 * @param {string} jsonPath - JSONPath expression (e.g., $.userName, $.profile.electronicAddresses[0].email)
 * @returns {any} Extracted value or null if not found
 */
export const getValueFromJsonPath = (jsonData, jsonPath) => {
  try {
    // Simple JSONPath implementation with array support
    if (!jsonPath.startsWith("$")) return null;

    // Remove the leading $. if present
    let path = jsonPath.startsWith("$.") ? jsonPath.substring(2) : jsonPath.substring(1);

    // Split the path into segments, handling array indices
    const segments = [];
    let currentSegment = "";
    let inBrackets = false;

    for (let i = 0; i < path.length; i++) {
      const char = path[i];

      if (char === "[") {
        if (currentSegment) {
          segments.push(currentSegment);
          currentSegment = "";
        }
        inBrackets = true;
      } else if (char === "]") {
        if (inBrackets && currentSegment) {
          // Parse array index (remove quotes if present)
          const index = currentSegment.replace(/['"]/g, "");
          segments.push(parseInt(index, 10));
          currentSegment = "";
        }
        inBrackets = false;
      } else if (char === "." && !inBrackets) {
        if (currentSegment) {
          segments.push(currentSegment);
          currentSegment = "";
        }
      } else {
        currentSegment += char;
      }
    }

    // Add the last segment if any
    if (currentSegment) {
      segments.push(currentSegment);
    }

    // Navigate through the object using the parsed segments
    let value = jsonData;
    for (const segment of segments) {
      // fixed because if for ex: subscription: null, then it will return null and it will fail
      // if (value === undefined || value === null) {
      //   return null;
      // }
      if (!(segment in value)) {
        // Path doesn’t exist
        return undefined;
      }
      value = value[segment];
    }

    return value;
  } catch (error) {
    debugLogger.error(
      DebugLogType.CLAIM,
      `[PARAMS-EXTRACTOR-UTILS] Error extracting JSON value with path ${jsonPath}:`,
      error,
    );
    return undefined;
  }
};

/**
 * Extract values from HTML response using XPath (simplified)
 * @param {string} htmlString - HTML string
 * @param {string} xPath - XPath expression
 * @returns {string|null|undefined} Extracted value or null if not found
 */
export const getValueFromXPath = (htmlString, xPath) => {
  // This is a simplified implementation
  // For proper XPath parsing, a library would be needed
  try {
    // Extract with regex based on the xPath pattern
    // This is a very basic implementation and won't work for all XPath expressions
    const cleanedXPath = xPath.replace(/^\/\//, "").replace(/\/@/, " ");
    const parts = cleanedXPath.split("/");
    const element = parts[parts.length - 1];

    // Simple regex to find elements with content
    const regex = new RegExp(`<${element}[^>]*>(.*?)<\/${element}>`, "i");
    const match = htmlString.match(regex);

    return match ? match[1] : undefined;
  } catch (error) {
    debugLogger.error(
      DebugLogType.CLAIM,
      `[PARAMS-EXTRACTOR-UTILS] Error extracting HTML value with XPath ${xPath}:`,
      error,
    );
    return undefined;
  }
};

/**
 * Check if a string appears to be JSON format
 * @param {string} text - Text to check
 * @returns {boolean} True if text appears to be JSON
 */
export const isJsonFormat = (text) => {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

/**
 * Safely parse JSON text
 * @param {string} jsonText - JSON text to parse
 * @returns {Object|null} Parsed JSON object or null if parsing fails
 */
export const safeJsonParse = (jsonText) => {
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    debugLogger.warn(
      DebugLogType.CLAIM,
      "[PARAMS-EXTRACTOR-UTILS] Response looks like JSON but couldn't be parsed",
    );
    return null;
  }
};
