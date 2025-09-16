/**
 * Utility functions for extracting values from JSON and HTML responses
 * Shared between network-filter.js and params-extractor.js
 */

import { debugLogger, DebugLogType } from "../logger";
import { JSONPath } from "jsonpath-plus";

/**
 * Extract values from JSON response using jsonPath
 * @param {Object} jsonData - Parsed JSON response
 * @param {string} jsonPath - JSONPath expression (e.g., $.userName, $.profile.electronicAddresses[0].email)
 * @returns {any} Extracted value or null if not found
 */
export const getValueFromJsonPath = (jsonData, jsonPath) => {
  try {
    const results = JSONPath({ path: jsonPath, json: jsonData });
    return results?.[0] ?? undefined;
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
