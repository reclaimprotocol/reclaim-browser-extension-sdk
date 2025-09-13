// Message router for background script
// Handles chrome.runtime.onMessage and routes actions to modules

import { LOG_TYPES } from "../utils/logger";
import * as sessionManager from "./sessionManager";

export async function handleMessage(ctx, message, sender, sendResponse) {
  const { action, source, target, data } = message;
  try {
    switch (action) {
      case ctx.MESSAGE_ACTIONS.CONTENT_SCRIPT_LOADED:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          if (ctx?.sessionId) {
            ctx.bgLogger.setContext({
              sessionId: ctx.sessionId || "unknown",
              providerId: ctx.providerId || "unknown",
              appId: ctx.appId || "unknown",
            });
          }
          const isManaged = sender.tab?.id && ctx.managedTabs.has(sender.tab.id);
          chrome.tabs
            .sendMessage(sender.tab.id, {
              action: ctx.MESSAGE_ACTIONS.SHOULD_INITIALIZE,
              source: ctx.MESSAGE_SOURCES.BACKGROUND,
              target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
              data: { shouldInitialize: isManaged },
            })
            .catch((err) =>
              ctx.bgLogger.error(
                `[BACKGROUND] Error sending initialization status: ${err?.message}`,
              ),
            );

          if (isManaged && ctx.initPopupMessage && ctx.initPopupMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.initPopupMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  ctx.bgLogger.error(
                    `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                  );
                }
              })
              .catch((error) =>
                ctx.bgLogger.error(
                  `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                ),
              );
          }

          if (isManaged && ctx.providerDataMessage && ctx.providerDataMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.providerDataMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  ctx.bgLogger.error(
                    `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                  );
                }
              })
              .catch((error) =>
                ctx.bgLogger.error(
                  `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                ),
              );
            ctx.providerDataMessage.delete(sender.tab.id);
          }

          sendResponse({ success: true });
          break;
        }
        break;
      case ctx.MESSAGE_ACTIONS.REQUEST_PROVIDER_DATA:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          ctx.bgLogger.setContext({
            sessionId: ctx.sessionId || "unknown",
            providerId: ctx.providerId || "unknown",
            appId: ctx.appId || "unknown",
            type: LOG_TYPES.BACKGROUND,
          });
          ctx.bgLogger.info("[BACKGROUND] Content script requested provider data");

          if (
            sender.tab?.id &&
            ctx.managedTabs.has(sender.tab.id) &&
            ctx.providerData &&
            ctx.parameters &&
            ctx.sessionId &&
            ctx.callbackUrl !== undefined // allow empty string as optional
          ) {
            ctx.bgLogger.info(
              "[BACKGROUND] Sending the following provider data to content script: " +
                JSON.stringify(ctx.providerData),
            );

            sendResponse({
              success: true,
              data: {
                providerData: ctx.providerData,
                parameters: ctx.parameters || {},
                sessionId: ctx.sessionId,
                callbackUrl: ctx.callbackUrl,
                providerId: ctx.providerId,
                appId: ctx.appId,
              },
            });
          } else {
            sendResponse({
              success: false,
              error: "Provider data not available or tab not managed",
            });
          }
        }
        break;
      case ctx.MESSAGE_ACTIONS.CHECK_IF_MANAGED_TAB:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          const isManaged = sender.tab?.id && ctx.managedTabs.has(sender.tab.id);
          sendResponse({ success: true, isManaged });
        }
        break;
      case ctx.MESSAGE_ACTIONS.START_VERIFICATION:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          ctx.bgLogger.setContext({
            sessionId: data.sessionId || ctx.sessionId || "unknown",
            providerId: data.providerId || ctx.providerId || "unknown",
            appId: data.applicationId || ctx.appId || "unknown",
            type: LOG_TYPES.BACKGROUND,
          });
          ctx.bgLogger.info(
            "[BACKGROUND] Starting a new verification with data: " + JSON.stringify(data),
          );

          ctx.loggerService.startFlushInterval();

          // Concurrency guard
          if (ctx.activeSessionId && ctx.activeSessionId !== data.sessionId) {
            // If no managed tabs remain, clear stale guard and continue
            if (ctx.managedTabs.size === 0) {
              ctx.activeSessionId = null;
            } else {
              ctx.bgLogger.error(`[BACKGROUND] Another verification is in progress`);
              sendResponse({ success: false, error: "Another verification is in progress" });
              break;
            }
          }
          ctx.activeSessionId = data.sessionId || ctx.activeSessionId;

          if (sender.tab && sender.tab.id) {
            ctx.originalTabId = sender.tab.id;
          }
          ctx.bgLogger.info(
            `[BACKGROUND] Starting verification with session id: ${data.sessionId}`,
          );
          const result = await sessionManager.startVerification(ctx, data);

          ctx.bgLogger.info(`[BACKGROUND] Verification started with session id: ${data.sessionId}`);
          sendResponse({ success: true, result });
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.CANCEL_VERIFICATION:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          ctx.bgLogger.info(
            `[BACKGROUND] Cancelling verification with session id: ${data?.sessionId}`,
          );
          await sessionManager.cancelSession(ctx, data?.sessionId);
          sendResponse({ success: true });
        } else {
          ctx.bgLogger.error(`[BACKGROUND] CANCEL_VERIFICATION: Action not supported`);
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY:
        if (source === ctx.MESSAGE_SOURCES.OFFSCREEN && target === ctx.MESSAGE_SOURCES.BACKGROUND) {
          ctx.bgLogger.info(`[BACKGROUND] Offscreen document ready`);
          sendResponse({ success: true });
        } else {
          ctx.bgLogger.error(`[BACKGROUND] OFFSCREEN_DOCUMENT_READY: Action not supported`);
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.CLOSE_CURRENT_TAB:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          if (sender.tab && sender.tab.id) {
            chrome.tabs.remove(sender.tab.id, () => {
              if (chrome.runtime.lastError) {
                ctx.bgLogger.error(
                  `[BACKGROUND] Error closing tab: ${chrome.runtime.lastError.message}`,
                );
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                if (ctx.managedTabs.has(sender.tab.id)) {
                  ctx.managedTabs.delete(sender.tab.id);
                }
                sendResponse({ success: true });
              }
            });
          } else {
            ctx.bgLogger.error(`[BACKGROUND] CLOSE_CURRENT_TAB: No tab ID provided by sender.`);
            sendResponse({ success: false, error: "No tab ID found to close." });
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        return true;
      case ctx.MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          if (ctx.filteredRequests.has(data.criteria.requestHash)) {
            ctx.bgLogger.info(
              `[BACKGROUND] Filtered request found with hash: ${data.criteria.requestHash}`,
            );
            sendResponse({
              success: true,
              result: ctx.filteredRequests.get(data.criteria.requestHash),
            });
          } else {
            ctx.filteredRequests.set(data.criteria.requestHash, data.request);
            const result = await ctx.processFilteredRequest(
              data.request,
              data.criteria,
              data.sessionId,
              data.loginUrl,
            );
            sendResponse({ success: true, result });
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.GET_CURRENT_TAB_ID:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          ctx.bgLogger.info(`[BACKGROUND] Getting current tab id: ${sender.tab?.id}`);
          sendResponse({ success: true, tabId: sender.tab?.id });
        } else {
          ctx.bgLogger.error(`[BACKGROUND] GET_CURRENT_TAB_ID: Action not supported`);
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_PUBLIC_DATA:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.bgLogger.info(`[BACKGROUND] Updating public data: ${data?.publicData}`);
          ctx.publicData = typeof data?.publicData === "string" ? data.publicData : null;
          sendResponse({ success: true });
        } else {
          ctx.bgLogger.error(`[BACKGROUND] UPDATE_PUBLIC_DATA: Tab is not managed by extension`);
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_EXPECT_MANY_CLAIMS: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          const turningOff = ctx.expectManyClaims && !data?.expectMany;
          ctx.expectManyClaims = !!data?.expectMany;

          ctx.bgLogger.info(`[BACKGROUND] Updating expect many claims: ${data?.expectMany}`);

          // If turning OFF and proofs are already ready, finish now
          if (turningOff && ctx.generatedProofs.size > 0) {
            try {
              ctx.bgLogger.info(`[BACKGROUND] Turning off expect many claims, Submitting proofs`);
              await ctx.submitProofs();
            } catch {}
          }
          sendResponse({ success: true });
        } else {
          ctx.bgLogger.error(
            `[BACKGROUND] UPDATE_EXPECT_MANY_CLAIMS: Tab is not managed by extension`,
          );
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      case ctx.MESSAGE_ACTIONS.GET_PARAMETERS:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.bgLogger.info(`[BACKGROUND] Getting parameters: ${ctx.parameters}`);
          sendResponse({ success: true, parameters: ctx.parameters || {} });
        } else {
          ctx.bgLogger.error(
            `[BACKGROUND] UPDATE_EXPECT_MANY_CLAIMS: Tab is not managed by extension`,
          );
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.REPORT_PROVIDER_ERROR: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.aborted = true;
          await ctx.failSession(data?.message || "Provider error");
          ctx.bgLogger.info(`[BACKGROUND] Provider error reported: ${data?.message}`);
          sendResponse({ success: true });
        } else {
          ctx.bgLogger.error(`[BACKGROUND] REPORT_PROVIDER_ERROR: Tab is not managed by extension`);
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      case ctx.MESSAGE_ACTIONS.REQUEST_CLAIM: {
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND &&
          sender.tab?.id &&
          ctx.managedTabs.has(sender.tab.id)
        ) {
          try {
            const sessId = ctx.sessionId || data.sessionId;
            if (!sessId) {
              sendResponse({ success: false, error: "Session not initialized" });
              break;
            }
            const result = await ctx.processFilteredRequest(
              data.request, // carries url/method/headers/body/extractedParams
              data.criteria, // responseMatches/redactions, requestHash
              data.sessionId, // current session
              data.loginUrl || "", // referer/login
            );

            ctx.bgLogger.info(`[BACKGROUND] Request claim processed: ${data.requestHash}`);

            sendResponse({ success: true, result });
          } catch (e) {
            ctx.bgLogger.error(`[BACKGROUND] Request claim processing failed: ${e?.message}`);
            sendResponse({ success: false, error: e?.message || String(e) });
          }
        } else {
          ctx.bgLogger.error(`[BACKGROUND] REQUEST_CLAIM: Tab is not managed by extension`);
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      default: {
        ctx.bgLogger.error(`[BACKGROUND] DEFAULT: Action not supported`);
        sendResponse({ success: false, error: "Action not supported" });
      }
    }
  } catch (error) {
    ctx.bgLogger.error(`[BACKGROUND] Error handling ${action}: ${error?.message}`);
    sendResponse({ success: false, error: error.message });
  }
  // Required for async response
  return true;
}
