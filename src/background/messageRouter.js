// Message router for background script
// Handles chrome.runtime.onMessage and routes actions to modules

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
          const isManaged = sender.tab?.id && ctx.managedTabs.has(sender.tab.id);
          chrome.tabs
            .sendMessage(sender.tab.id, {
              action: ctx.MESSAGE_ACTIONS.SHOULD_INITIALIZE,
              source: ctx.MESSAGE_SOURCES.BACKGROUND,
              target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
              data: { shouldInitialize: isManaged },
            })
            .catch((err) =>
              ctx.debugLogger.error(
                ctx.DebugLogType.BACKGROUND,
                "[BACKGROUND] Error sending initialization status:",
                err,
              ),
            );

          if (isManaged && ctx.initPopupMessage && ctx.initPopupMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.initPopupMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  ctx.debugLogger.error(
                    ctx.DebugLogType.BACKGROUND,
                    `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id}:`,
                    chrome.runtime.lastError.message,
                  );
                }
              })
              .catch((error) =>
                ctx.debugLogger.error(
                  ctx.DebugLogType.BACKGROUND,
                  `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id} (promise catch):`,
                  error,
                ),
              );
          }

          if (isManaged && ctx.providerDataMessage && ctx.providerDataMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.providerDataMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  ctx.debugLogger.error(
                    ctx.DebugLogType.BACKGROUND,
                    `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id}:`,
                    chrome.runtime.lastError.message,
                  );
                }
              })
              .catch((error) =>
                ctx.debugLogger.error(
                  ctx.DebugLogType.BACKGROUND,
                  `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id} (promise catch):`,
                  error,
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
          ctx.loggerService.log({
            message: "Content script requested provider data",
            type: ctx.LOG_TYPES.BACKGROUND,
            sessionId: ctx.sessionId || "unknown",
            providerId: ctx.httpProviderId || "unknown",
            appId: ctx.appId || "unknown",
          });

          if (
            sender.tab?.id &&
            ctx.managedTabs.has(sender.tab.id) &&
            ctx.providerData &&
            ctx.parameters &&
            ctx.sessionId &&
            ctx.callbackUrl !== undefined // allow empty string as optional
          ) {
            ctx.loggerService.log({
              message:
                "Sending the following provider data to content script: " +
                JSON.stringify(ctx.providerData),
              type: ctx.LOG_TYPES.BACKGROUND,
              sessionId: ctx.sessionId || "unknown",
              providerId: ctx.httpProviderId || "unknown",
              appId: ctx.appId || "unknown",
            });
            sendResponse({
              success: true,
              data: {
                providerData: ctx.providerData,
                parameters: ctx.parameters || {},
                sessionId: ctx.sessionId,
                callbackUrl: ctx.callbackUrl,
                httpProviderId: ctx.httpProviderId,
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
          console.log("START VERIFICATION FROM BACKGROUND", { data });
          ctx.loggerService.log({
            message: "Starting a new verification with data: " + JSON.stringify(data),
            type: ctx.LOG_TYPES.BACKGROUND,
            sessionId: data.sessionId || "unknown",
            providerId: data.providerId || "unknown",
            appId: data.applicationId || "unknown",
          });
          ctx.loggerService.startFlushInterval();

          // Concurrency guard
          if (ctx.activeSessionId && ctx.activeSessionId !== data.sessionId) {
            sendResponse({ success: false, error: "Another verification is in progress" });
            break;
          }
          ctx.activeSessionId = data.sessionId || ctx.activeSessionId;

          if (sender.tab && sender.tab.id) {
            ctx.originalTabId = sender.tab.id;
          }
          const result = await sessionManager.startVerification(ctx, data);
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
          await sessionManager.cancelSession(ctx, data?.sessionId);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY:
        if (source === ctx.MESSAGE_SOURCES.OFFSCREEN && target === ctx.MESSAGE_SOURCES.BACKGROUND) {
          sendResponse({ success: true });
        } else {
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
                ctx.debugLogger.error(
                  ctx.DebugLogType.BACKGROUND,
                  "[BACKGROUND] Error closing tab:",
                  chrome.runtime.lastError.message,
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
            ctx.debugLogger.error(
              ctx.DebugLogType.BACKGROUND,
              "[BACKGROUND] CLOSE_CURRENT_TAB: No tab ID provided by sender.",
            );
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
          sendResponse({ success: true, tabId: sender.tab?.id });
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_PUBLIC_DATA:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.publicData = typeof data?.publicData === "string" ? data.publicData : null;
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_EXPECT_MANY_CLAIMS: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          const turningOff = ctx.expectManyClaims && !data?.expectMany;
          ctx.expectManyClaims = !!data?.expectMany;

          // If turning OFF and proofs are already ready, finish now
          if (turningOff && ctx.generatedProofs.size > 0) {
            try {
              await ctx.submitProofs();
            } catch {}
          }
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      case ctx.MESSAGE_ACTIONS.GET_PARAMETERS:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          sendResponse({ success: true, parameters: ctx.parameters || {} });
        } else {
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      // src/background/messageRouter.js
      case ctx.MESSAGE_ACTIONS.REPORT_PROVIDER_ERROR: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.aborted = true;
          await ctx.failSession(data?.message || "Provider error");
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      default:
        sendResponse({ success: false, error: "Action not supported" });
    }
  } catch (error) {
    ctx.debugLogger.error(
      ctx.DebugLogType.BACKGROUND,
      `[BACKGROUND] Error handling ${action}:`,
      error,
    );
    sendResponse({ success: false, error: error.message });
  }
  // Required for async response
  return true;
}
