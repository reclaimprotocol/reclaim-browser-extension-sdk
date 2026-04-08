/**
 * CSP Rule Manager
 *
 * Temporarily strips Content-Security-Policy headers from provider pages
 * during verification flows using chrome.declarativeNetRequest session rules.
 * This allows custom injection scripts to execute on strict-CSP sites (e.g. LinkedIn).
 *
 * Rules are scoped to the provider's hostname and only affect main_frame/sub_frame.
 * Session rules are automatically cleared on browser restart.
 */

import { loggingHub } from "../utils/logger/LoggingHub";
import { CSP_RULE_ID } from "../utils/constants/config";

/**
 * Add a session rule that strips CSP headers for the given provider URL's hostname.
 * @param {string} providerUrl - The provider's login URL
 * @returns {Promise<{ruleId: number}>}
 */
export async function addCspStrippingRule(providerUrl) {
  const urlObj = new URL(providerUrl);

  const rule = {
    id: CSP_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ],
    },
    condition: {
      urlFilter: `*://${urlObj.hostname}/*`,
      resourceTypes: ["main_frame", "sub_frame"],
    },
  };

  // Remove any stale rule first, then add the new one
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [CSP_RULE_ID],
    addRules: [rule],
  });

  loggingHub.info(
    `[CSP-MANAGER] CSP stripping rule added for ${urlObj.hostname}`,
    "background.csp",
  );

  return { ruleId: CSP_RULE_ID };
}

/**
 * Remove the CSP stripping session rule.
 */
export async function removeCspStrippingRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [CSP_RULE_ID],
    });
    loggingHub.info("[CSP-MANAGER] CSP stripping rule removed", "background.csp");
  } catch {
    // Rule may already be removed — ignore
  }
}
