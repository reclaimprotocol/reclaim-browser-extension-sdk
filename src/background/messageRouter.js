// Message router for background script
// Handles chrome.runtime.onMessage and routes actions to modules

import { LOG_TYPES, LOG_LEVEL, EVENT_TYPES } from "../utils/logger";
import * as sessionManager from "./sessionManager";

export async function handleMessage(ctx, message, sender, sendResponse) {
  const { action, source, target, data } = message;
  const bgLogger = ctx.bgLogger;
  bgLogger.setContext({
    type: LOG_TYPES.BACKGROUND,
    sessionId: ctx.sessionId || "unknown",
    providerId: ctx.providerId || "unknown",
    appId: ctx.appId || "unknown",
  });
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
              bgLogger.error({
                message: "[BACKGROUND] Error sending initialization status: " + err?.message,
                logLevel: LOG_LEVEL.INFO,
                type: LOG_TYPES.BACKGROUND,
              }),
            );

          if (isManaged && ctx.initPopupMessage && ctx.initPopupMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.initPopupMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  bgLogger.error({
                    message: `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                    logLevel: LOG_LEVEL.INFO,
                    type: LOG_TYPES.BACKGROUND,
                    eventType: EVENT_TYPES.VERIFICATION_POPUP_ERROR,
                  });
                }
              })
              .catch((error) =>
                bgLogger.error({
                  message: `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                  logLevel: LOG_LEVEL.INFO,
                  type: LOG_TYPES.BACKGROUND,
                  eventType: EVENT_TYPES.VERIFICATION_POPUP_ERROR,
                }),
              );
          }

          if (isManaged && ctx.providerDataMessage && ctx.providerDataMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.providerDataMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  bgLogger.error({
                    message: `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                    logLevel: LOG_LEVEL.INFO,
                    type: LOG_TYPES.BACKGROUND,
                    eventType: EVENT_TYPES.RECLAIM_VERIFICATION_PROVIDER_LOAD_EXCEPTION,
                  });
                }
              })
              .catch((error) =>
                bgLogger.error({
                  message: `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                  logLevel: LOG_LEVEL.INFO,
                  type: LOG_TYPES.BACKGROUND,
                  eventType: EVENT_TYPES.RECLAIM_VERIFICATION_PROVIDER_LOAD_EXCEPTION,
                }),
              );
            ctx.providerDataMessage.delete(sender.tab.id);
          }

          bgLogger.info({
            message: `[BACKGROUND] Successfully sent (pending) SHOW_PROVIDER_VERIFICATION_POPUP and PROVIDER_DATA_READY to tab ${sender.tab.id}`,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: true });
          break;
        }
        break;
      case ctx.MESSAGE_ACTIONS.REQUEST_PROVIDER_DATA:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          bgLogger.setContext({
            sessionId: ctx.sessionId || "unknown",
            providerId: ctx.providerId || "unknown",
            appId: ctx.appId || "unknown",
            type: LOG_TYPES.BACKGROUND,
          });
          bgLogger.info({
            message: "[BACKGROUND] Content script requested provider data",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });

          if (
            sender.tab?.id &&
            ctx.managedTabs.has(sender.tab.id) &&
            ctx.providerData &&
            ctx.parameters &&
            ctx.sessionId &&
            ctx.callbackUrl !== undefined // allow empty string as optional
          ) {
            bgLogger.info({
              message:
                "[BACKGROUND] Sending the following provider data to content script: " +
                JSON.stringify(ctx.providerData),
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
            });

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
            bgLogger.error({
              message: "[BACKGROUND] Provider data not available or tab not managed",
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
            });
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
          bgLogger.info({
            message: "[BACKGROUND] Checking if tab is managed: " + isManaged,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: true, isManaged });
        }
        break;
      case ctx.MESSAGE_ACTIONS.START_VERIFICATION:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          bgLogger.setContext({
            sessionId: data.sessionId || ctx.sessionId || "unknown",
            providerId: data.providerId || ctx.providerId || "unknown",
            appId: data.applicationId || ctx.appId || "unknown",
            type: LOG_TYPES.BACKGROUND,
          });

          bgLogger.info({
            message: "Starting new verification using Reclaim Extension SDK",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
            eventType: EVENT_TYPES.IS_RECLAIM_EXTENSION_SDK,
          });

          bgLogger.info({
            message:
              "[BACKGROUND] Starting new verification flow with data: " + JSON.stringify(data),
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
            eventType: EVENT_TYPES.VERIFICATION_FLOW_STARTED,
          });

          ctx.loggerService.startFlushInterval();

          // Concurrency guard
          if (ctx.activeSessionId && ctx.activeSessionId !== data.sessionId) {
            // If no managed tabs remain, clear stale guard and continue
            if (ctx.managedTabs.size === 0) {
              ctx.activeSessionId = null;
            } else {
              bgLogger.error({
                message: "[BACKGROUND] Another verification is in progress",
                logLevel: LOG_LEVEL.INFO,
                type: LOG_TYPES.BACKGROUND,
              });
              sendResponse({ success: false, error: "Another verification is in progress" });
              break;
            }
          }
          ctx.activeSessionId = data.sessionId || ctx.activeSessionId;

          if (sender.tab && sender.tab.id) {
            ctx.originalTabId = sender.tab.id;
          }
          bgLogger.info({
            message: "[BACKGROUND] Starting verification with session id: " + data.sessionId,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });

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
          bgLogger.info({
            message: "[BACKGROUND] Cancelling verification with session id: " + data?.sessionId,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });

          await sessionManager.cancelSession(ctx, data?.sessionId);
          sendResponse({ success: true });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] CANCEL_VERIFICATION: Action not supported",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY:
        if (source === ctx.MESSAGE_SOURCES.OFFSCREEN && target === ctx.MESSAGE_SOURCES.BACKGROUND) {
          bgLogger.info({
            message: "[BACKGROUND] Offscreen document ready",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: true });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] OFFSCREEN_DOCUMENT_READY: Action not supported",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
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
                bgLogger.error({
                  message: "[BACKGROUND] Error closing tab: " + chrome.runtime.lastError.message,
                  logLevel: LOG_LEVEL.INFO,
                  type: LOG_TYPES.BACKGROUND,
                });
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                if (ctx.managedTabs.has(sender.tab.id)) {
                  ctx.managedTabs.delete(sender.tab.id);
                }
                bgLogger.info({
                  message: "[BACKGROUND] Tab closed",
                  logLevel: LOG_LEVEL.INFO,
                  type: LOG_TYPES.BACKGROUND,
                });
                sendResponse({ success: true });
              }
            });
          } else {
            bgLogger.error({
              message: "[BACKGROUND] CLOSE_CURRENT_TAB: No tab ID provided by sender.",
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
            });
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
            bgLogger.info({
              message:
                "[BACKGROUND] Filtered request found with hash: " + data.criteria.requestHash,
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
              eventType: EVENT_TYPES.FILTERED_REQUEST_FOUND,
            });
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
            bgLogger.info({
              message:
                "[BACKGROUND] Filtered request processed with hash: " + data.criteria.requestHash,
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
            });
            sendResponse({ success: true, result });
          }
        } else {
          bgLogger.error({
            message: "[BACKGROUND] FILTERED_REQUEST_FOUND: Action not supported",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.GET_CURRENT_TAB_ID:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          bgLogger.info({
            message: "[BACKGROUND] Getting current tab id: " + sender.tab?.id,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: true, tabId: sender.tab?.id });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] GET_CURRENT_TAB_ID: Action not supported",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_PUBLIC_DATA:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          bgLogger.info({
            message: "[BACKGROUND] Updating public data: " + data?.publicData,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          ctx.publicData = typeof data?.publicData === "string" ? data.publicData : null;
          sendResponse({ success: true });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] UPDATE_PUBLIC_DATA: Tab is not managed by extension",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_EXPECT_MANY_CLAIMS: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          const turningOff = ctx.expectManyClaims && !data?.expectMany;
          ctx.expectManyClaims = !!data?.expectMany;

          bgLogger.info({
            message: "[BACKGROUND] Updating expect many claims: " + data?.expectMany,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });

          // If turning OFF and proofs are already ready, finish now
          if (turningOff && ctx.generatedProofs.size > 0) {
            try {
              bgLogger.info({
                message: "[BACKGROUND] Turning off expect many claims, Submitting proofs",
                logLevel: LOG_LEVEL.INFO,
                type: LOG_TYPES.BACKGROUND,
              });
              await ctx.submitProofs();
            } catch {}
          }
          sendResponse({ success: true });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] UPDATE_EXPECT_MANY_CLAIMS: Tab is not managed by extension",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      case ctx.MESSAGE_ACTIONS.GET_PARAMETERS:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          bgLogger.info({
            message: "[BACKGROUND] Getting parameters: " + ctx.parameters,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: true, parameters: ctx.parameters || {} });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] UPDATE_EXPECT_MANY_CLAIMS: Tab is not managed by extension",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.REPORT_PROVIDER_ERROR: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.aborted = true;
          await ctx.failSession(data?.message || "Provider error");
          bgLogger.info({
            message: "[BACKGROUND] Provider error reported: " + data?.message,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: true });
        } else {
          bgLogger.error({
            message: "[BACKGROUND] REPORT_PROVIDER_ERROR: Tab is not managed by extension",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
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
              data.request,
              data.criteria,
              data.sessionId,
              data.loginUrl || "",
            );

            bgLogger.info({
              message: "[BACKGROUND] Request claim processed: " + data.requestHash,
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
            });

            sendResponse({ success: true, result });
          } catch (e) {
            bgLogger.error({
              message: "[BACKGROUND] Request claim processing failed: " + e?.message,
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
            });
            sendResponse({ success: false, error: e?.message || String(e) });
          }
        } else {
          bgLogger.error({
            message: "[BACKGROUND] REQUEST_CLAIM: Tab is not managed by extension",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      // Add/extend this case in the switch
      case ctx.MESSAGE_ACTIONS.INJECT_VIA_SCRIPTING: {
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND &&
          sender.tab?.id
        ) {
          const tabId = sender.tab.id;
          const op = data?.op;

          try {
            if (op === "REPLAY_PAGE_FETCH") {
              bgLogger.info({
                message: "[BACKGROUND] REPLAY_PAGE_FETCH: Executing script",
                logLevel: LOG_LEVEL.INFO,
                type: LOG_TYPES.BACKGROUND,
              });
              await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: (opts) => {
                  try {
                    if (opts?.showAlert) {
                      // Use non-blocking console too in case alerts are suppressed
                      console.log("Fetching initial page…");
                    }
                    fetch(window.location.href, {
                      method: "GET",
                      headers: {
                        accept:
                          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                        "accept-language": "en-GB,en;q=0.5",
                      },
                      credentials: "include",
                      cache: "no-store",
                    }).catch(() => {});
                  } catch (e) {
                    bgLogger.error({
                      message: "[BACKGROUND] REPLAY_PAGE_FETCH failed: " + e?.message,
                      logLevel: LOG_LEVEL.INFO,
                      type: LOG_TYPES.BACKGROUND,
                    });
                  }
                },
                args: [{ showAlert: !!data?.showAlert }],
              });

              bgLogger.info({
                message: "[BACKGROUND] REPLAY_PAGE_FETCH executed in MAIN world",
                logLevel: LOG_LEVEL.INFO,
                type: LOG_TYPES.BACKGROUND,
              });
              sendResponse({ success: true });
              break;
            }

            if (op === "RUN_CUSTOM_INJECTION") {
              const code = String(data?.code || "");
              const results = await chrome.scripting.executeScript({
                target: { tabId: sender.tab.id },
                world: "MAIN",
                func: (opts) => {
                  try {
                    const code = String(opts?.code || "");
                    if (!code) return { status: "skipped", reason: "no_code" };
                    if (window.__reclaimCustomInjectionDone__) {
                      return { status: "skipped", reason: "already_injected" };
                    }

                    // 1) Use page nonce if available (CSP-compliant)
                    const tryWithNonce = () => {
                      try {
                        const nonce = (document.querySelector("script[nonce]") || {}).nonce;
                        if (!nonce) return false;
                        const s = document.createElement("script");
                        s.setAttribute("nonce", nonce);
                        s.textContent = code;
                        (document.documentElement || document.head || document).appendChild(s);
                        s.remove();
                        return true;
                      } catch {
                        return false;
                      }
                    };

                    // 2) Trusted Types + nonce (still needs nonce on TT-enforced sites)
                    const tryWithTT = () => {
                      try {
                        if (!window.trustedTypes) return false;
                        const nonce = (document.querySelector("script[nonce]") || {}).nonce || "";
                        const names = [
                          "reclaim-extension-sdk",
                          "reclaim",
                          "default",
                          "policy",
                          "app",
                        ];
                        for (const name of names) {
                          try {
                            const policy = window.trustedTypes.createPolicy(name, {
                              createScript: (s) => s,
                            });
                            const s = document.createElement("script");
                            if (nonce) s.setAttribute("nonce", nonce);
                            s.text = policy.createScript(code);
                            (document.documentElement || document.head || document).appendChild(s);
                            s.remove();
                            return true;
                          } catch {}
                        }
                        return false;
                      } catch {
                        return false;
                      }
                    };

                    // 3) Plain inline (last resort; typically blocked)
                    const tryPlain = () => {
                      try {
                        const s = document.createElement("script");
                        s.textContent = code;
                        (document.documentElement || document.head || document).appendChild(s);
                        s.remove();
                        return true;
                      } catch {
                        return false;
                      }
                    };

                    const ok =
                      tryWithNonce() || // best chance
                      tryWithTT() || // TT with nonce when possible
                      tryPlain(); // may be blocked

                    if (ok) {
                      window.__reclaimCustomInjectionDone__ = true;
                      return { status: "executed" };
                    }
                    return { status: "error", reason: "all_strategies_failed" };
                  } catch (e) {
                    return { status: "error", reason: String(e?.message || e) };
                  }
                },
                args: [{ code }],
              });

              const result = results?.[0]?.result;
              bgLogger.info({
                message: "[BACKGROUND] RUN_CUSTOM_INJECTION result: " + JSON.stringify(result),
                logLevel: LOG_LEVEL.INFO,
                type: LOG_TYPES.BACKGROUND,
                meta: { result },
              });
              sendResponse({ success: true, result });
              break;
            }
          } catch (e) {
            bgLogger.error({
              message: "[BACKGROUND] INJECT_VIA_SCRIPTING failed: " + e?.message,
              logLevel: LOG_LEVEL.INFO,
              type: LOG_TYPES.BACKGROUND,
              meta: { e },
            });
            sendResponse({ success: false, error: e?.message || String(e) });
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      }
      default: {
        bgLogger.error({
          message: "[BACKGROUND] DEFAULT: Action not supported",
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        sendResponse({ success: false, error: "Action not supported" });
      }
    }
  } catch (error) {
    bgLogger.error({
      message: "[BACKGROUND] Error handling " + action + ": " + error?.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      meta: { error },
    });
    sendResponse({ success: false, error: error.message });
  }
  // Required for async response
  return true;
}
