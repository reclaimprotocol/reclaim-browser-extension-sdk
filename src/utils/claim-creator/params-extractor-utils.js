/**
 * Shared JSON helpers for the content-script request filter.
 *
 * The xPath/jsonPath value extractors that used to live here are gone: they
 * diverged from the attestor (a regex-on-tag-name "XPath", and a JSONPath that
 * returned a re-serialized JS value rather than the raw response slice), which
 * meant a provider path that worked in the attestor and the InApp SDK could
 * silently fail here. Authoritative extraction now lives in
 * ./attestor-extraction.js on top of the vendored attestor code.
 */

import { JSONPath } from "jsonpath-plus";

/**
 * Does this jsonPath resolve against this response body?
 *
 * Uses the same JSONPath options as the attestor's `extractJSONValueIndexes`
 * (wrap/resultType/eval/ignoreEvalErrors), so the content-script gate agrees
 * with the attestor about whether a path exists. It deliberately stops at
 * "does a pointer come back" — turning the pointer into a byte range needs
 * esprima, and that only happens in the background, where the authoritative
 * extraction runs.
 *
 * @param {string} responseText - raw response body
 * @returns {boolean}
 */
export const jsonPathExists = (responseText, jsonPath) => {
  try {
    const pointers = JSONPath({
      path: jsonPath,
      json: JSON.parse(responseText),
      wrap: false,
      resultType: "pointer",
      eval: "safe",
      ignoreEvalErrors: true,
    });
    if (!pointers) return false;
    return Array.isArray(pointers) ? pointers.length > 0 : true;
  } catch {
    return false;
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
    console.warn("[PARAMS-EXTRACTOR-UTILS] Response looks like JSON but couldn't be parsed");
    return null;
  }
};
