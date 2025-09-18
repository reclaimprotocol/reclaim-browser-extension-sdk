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
              await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: (opts) => {
                  try {
                    if (opts?.showAlert) {
                      // Use non-blocking console too in case alerts are suppressed
                      console.log("Fetching initial page…");
                      alert("Fetching initial page…");
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
                    console.error("REPLAY_PAGE_FETCH failed", e);
                  }
                },
                args: [{ showAlert: !!data?.showAlert }],
              });

              ctx.bgLogger?.info("INJECT_VIA_SCRIPTING: REPLAY_PAGE_FETCH executed in MAIN world");
              sendResponse({ success: true });
              break;
            }

            // In src/background/messageRouter.js, inside INJECT_VIA_SCRIPTING case
            // inside INJECT_VIA_SCRIPTING case
            // src/background/messageRouter.js (inside INJECT_VIA_SCRIPTING case)
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
                            const policy = trustedTypes.createPolicy(name, {
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
              ctx.bgLogger?.info(
                `INJECT_VIA_SCRIPTING: RUN_CUSTOM_INJECTION result: ${JSON.stringify(result)}`,
              );
              sendResponse({ success: true, result });
              break;
            }
          } catch (e) {
            ctx.bgLogger?.error(`INJECT_VIA_SCRIPTING failed: ${e?.message}`);
            sendResponse({ success: false, error: e?.message || String(e) });
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
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
