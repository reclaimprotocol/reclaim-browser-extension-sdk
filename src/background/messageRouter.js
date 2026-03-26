// Message router for background script
// Handles chrome.runtime.onMessage and routes actions to modules

import { loggingHub } from "../utils/logger/LoggingHub";
import * as sessionManager from "./sessionManager";

export async function handleMessage(ctx, message, sender, sendResponse) {
  const { action, source, target, data } = message;

  try {
    // Handle LOG_MESSAGE action from content/offscreen
    if (action === ctx.MESSAGE_ACTIONS.LOG_MESSAGE) {
      ctx.loggingHub.handleRemoteLog(data.message, data.type, data.level || "INFO");
      sendResponse({ success: true });
      return true;
    }

    // Handle UPDATE_LOG_CONFIG action - directly update LoggingHub config
    if (action === ctx.MESSAGE_ACTIONS.UPDATE_LOG_CONFIG) {
      if (data?.config) {
        ctx.loggingHub.setConfig(data.config);
      }
      sendResponse({ success: true });
      return true;
    }

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
              loggingHub.error(
                "[BACKGROUND] Error sending initialization status: " + err?.message,
                "background.message",
              ),
            );

          if (isManaged && ctx.initPopupMessage && ctx.initPopupMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.initPopupMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  loggingHub.error(
                    `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                    "background.popup",
                  );
                }
              })
              .catch((error) =>
                loggingHub.error(
                  `[BACKGROUND] Error sending (pending) SHOW_PROVIDER_VERIFICATION_POPUP to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                  "background.popup",
                ),
              );
          }

          if (isManaged && ctx.providerDataMessage && ctx.providerDataMessage.has(sender.tab.id)) {
            const pendingMessage = ctx.providerDataMessage.get(sender.tab.id);
            chrome.tabs
              .sendMessage(sender.tab.id, pendingMessage.message)
              .then(() => {
                if (chrome.runtime.lastError) {
                  loggingHub.error(
                    `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id}: ${chrome.runtime.lastError.message}`,
                    "background.provider",
                  );
                }
              })
              .catch((error) =>
                loggingHub.error(
                  `[BACKGROUND] Error sending (pending) PROVIDER_DATA_READY to tab ${sender.tab.id} (promise catch): ${error?.message}`,
                  "background.provider",
                ),
              );
            ctx.providerDataMessage.delete(sender.tab.id);
          }

          loggingHub.info(
            `[BACKGROUND] Successfully sent (pending) SHOW_PROVIDER_VERIFICATION_POPUP and PROVIDER_DATA_READY to tab ${sender.tab.id}`,
            "background.message",
          );
          sendResponse({ success: true });
          break;
        }
        break;
      case ctx.MESSAGE_ACTIONS.REQUEST_PROVIDER_DATA:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          loggingHub.info(
            "[BACKGROUND] Content script requested provider data",
            "background.provider",
          );

          if (
            sender.tab?.id &&
            ctx.managedTabs.has(sender.tab.id) &&
            ctx.providerData &&
            ctx.parameters &&
            ctx.sessionId &&
            ctx.callbackUrl !== undefined // allow empty string as optional
          ) {
            loggingHub.info(
              "[BACKGROUND] Sending the following provider data to content script: " +
                JSON.stringify(ctx.providerData),
              "background.provider",
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
            loggingHub.error(
              "[BACKGROUND] Provider data not available or tab not managed",
              "background.provider",
            );
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
          loggingHub.info(
            "[BACKGROUND] Checking if tab is managed: " + isManaged,
            "background.tab",
          );
          sendResponse({ success: true, isManaged });
        }
        break;
      case ctx.MESSAGE_ACTIONS.START_VERIFICATION:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          // Set session context in the logging hub
          ctx.loggingHub.setSessionContext({
            sessionId: data.sessionId,
            providerId: data.providerId,
            appId: data.applicationId,
          });

          loggingHub.info(
            "Starting new verification using Reclaim Extension SDK",
            "background.verification",
          );

          loggingHub.info(
            "[BACKGROUND] Starting new verification flow with data: " + JSON.stringify(data),
            "background.verification",
          );

          // Concurrency guard
          if (ctx.activeSessionId && ctx.activeSessionId !== data.sessionId) {
            // If no managed tabs remain, clear stale guard and continue
            if (ctx.managedTabs.size === 0) {
              ctx.activeSessionId = null;
            } else {
              loggingHub.error(
                "[BACKGROUND] Another verification is in progress",
                "background.verification",
              );
              sendResponse({ success: false, error: "Another verification is in progress" });
              break;
            }
          }
          ctx.activeSessionId = data.sessionId || ctx.activeSessionId;

          if (sender.tab && sender.tab.id) {
            ctx.originalTabId = sender.tab.id;
          }
          loggingHub.info(
            "[BACKGROUND] Starting verification with session id: " + data.sessionId,
            "background.verification",
          );

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
          loggingHub.info(
            "[BACKGROUND] Cancelling verification with session id: " + data?.sessionId,
            "background.verification",
          );

          await sessionManager.cancelSession(ctx, data?.sessionId);
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] CANCEL_VERIFICATION: Action not supported",
            "background.message",
          );
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY:
        if (source === ctx.MESSAGE_SOURCES.OFFSCREEN && target === ctx.MESSAGE_SOURCES.BACKGROUND) {
          loggingHub.info("[BACKGROUND] Offscreen document ready", "background.offscreen");
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] OFFSCREEN_DOCUMENT_READY: Action not supported",
            "background.message",
          );
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
                loggingHub.error(
                  "[BACKGROUND] Error closing tab: " + chrome.runtime.lastError.message,
                  "background.tab",
                );
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                if (ctx.managedTabs.has(sender.tab.id)) {
                  ctx.managedTabs.delete(sender.tab.id);
                }
                loggingHub.info("[BACKGROUND] Tab closed", "background.tab");
                sendResponse({ success: true });
              }
            });
          } else {
            loggingHub.error(
              "[BACKGROUND] CLOSE_CURRENT_TAB: No tab ID provided by sender.",
              "background.tab",
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
            loggingHub.info(
              "[BACKGROUND] Filtered request found with hash: " + data.criteria.requestHash,
              "background.filter",
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
            loggingHub.info(
              "[BACKGROUND] Filtered request processed with hash: " + data.criteria.requestHash,
              "background.filter",
            );
            sendResponse({ success: true, result });
          }
        } else {
          loggingHub.error(
            "[BACKGROUND] FILTERED_REQUEST_FOUND: Action not supported",
            "background.message",
          );
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.GET_CURRENT_TAB_ID:
        if (
          source === ctx.MESSAGE_SOURCES.CONTENT_SCRIPT &&
          target === ctx.MESSAGE_SOURCES.BACKGROUND
        ) {
          loggingHub.info(
            "[BACKGROUND] Getting current tab id: " + sender.tab?.id,
            "background.tab",
          );
          sendResponse({ success: true, tabId: sender.tab?.id });
        } else {
          loggingHub.error(
            "[BACKGROUND] GET_CURRENT_TAB_ID: Action not supported",
            "background.message",
          );
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_PUBLIC_DATA:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          loggingHub.info(
            "[BACKGROUND] Updating public data: " + data?.publicData,
            "background.data",
          );
          ctx.publicData = typeof data?.publicData === "string" ? data.publicData : null;
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] UPDATE_PUBLIC_DATA: Tab is not managed by extension",
            "background.data",
          );
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.UPDATE_EXPECT_MANY_CLAIMS: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          const turningOff = ctx.expectManyClaims && !data?.expectMany;
          ctx.expectManyClaims = !!data?.expectMany;

          loggingHub.info(
            "[BACKGROUND] Updating expect many claims: " + data?.expectMany,
            "background.claim",
          );

          // If turning OFF and proofs are already ready, finish now
          if (turningOff && ctx.generatedProofs.size > 0) {
            try {
              loggingHub.info(
                "[BACKGROUND] Turning off expect many claims, Submitting proofs",
                "background.proof",
              );
              await ctx.submitProofs();
            } catch {}
          }
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] UPDATE_EXPECT_MANY_CLAIMS: Tab is not managed by extension",
            "background.claim",
          );
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      }
      case ctx.MESSAGE_ACTIONS.GET_PARAMETERS:
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          loggingHub.info("[BACKGROUND] Getting parameters: " + ctx.parameters, "background.data");
          sendResponse({ success: true, parameters: ctx.parameters || {} });
        } else {
          loggingHub.error(
            "[BACKGROUND] GET_PARAMETERS: Tab is not managed by extension",
            "background.data",
          );
          sendResponse({ success: false, error: "Tab is not managed by extension" });
        }
        break;
      case ctx.MESSAGE_ACTIONS.REPORT_PROVIDER_ERROR: {
        if (sender.tab?.id && ctx.managedTabs.has(sender.tab.id)) {
          ctx.aborted = true;
          await ctx.failSession(data?.message || "Provider error");
          loggingHub.info(
            "[BACKGROUND] Provider error reported: " + data?.message,
            "background.provider",
          );
          sendResponse({ success: true });
        } else {
          loggingHub.error(
            "[BACKGROUND] REPORT_PROVIDER_ERROR: Tab is not managed by extension",
            "background.provider",
          );
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

            console.log("REQUEST_CLAIM result", result, data);

            loggingHub.info(
              "[BACKGROUND] Request claim processed: " + data.requestHash,
              "background.claim",
            );

            sendResponse({ success: true, result });
          } catch (e) {
            loggingHub.error(
              "[BACKGROUND] Request claim processing failed: " + e?.message,
              "background.claim",
            );
            sendResponse({ success: false, error: e?.message || String(e) });
          }
        } else {
          loggingHub.error(
            "[BACKGROUND] REQUEST_CLAIM: Tab is not managed by extension",
            "background.claim",
          );
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
              loggingHub.info(
                "[BACKGROUND] REPLAY_PAGE_FETCH: Executing script",
                "background.injection",
              );
              await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: (opts) => {
                  try {
                    const url = window.location.href;

                    // Prefer XHR to avoid any site reassignments of window.fetch
                    const xhr = new XMLHttpRequest();
                    xhr.open("GET", url, true);
                    xhr.withCredentials = true; // same-origin anyway, keeps cookies
                    xhr.setRequestHeader(
                      "accept",
                      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                    );
                    xhr.setRequestHeader("accept-language", "en-GB,en;q=0.5");
                    xhr.setRequestHeader("cache-control", "no-store");
                    // Optional debug marker
                    xhr.setRequestHeader("x-reclaim-replay", "1");

                    xhr.onreadystatechange = function () {
                      // No-op; interception happens in the patched XHR prototype
                    };
                    xhr.send(null);

                    if (opts?.showAlert) {
                      console.log("Replaying via XHR…", url);
                    }
                  } catch (e) {
                    console.log("REPLAY_PAGE_FETCH XHR failed:", e && e.message);
                  }
                },
                args: [{ showAlert: !!data?.showAlert }],
              });

              loggingHub.info(
                "[BACKGROUND] REPLAY_PAGE_FETCH executed in MAIN world (XHR)",
                "background.injection",
              );
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
              loggingHub.info(
                "[BACKGROUND] RUN_CUSTOM_INJECTION result: " + JSON.stringify(result),
                "background.injection",
              );
              sendResponse({ success: true, result });
              break;
            }
          } catch (e) {
            loggingHub.error(
              "[BACKGROUND] INJECT_VIA_SCRIPTING failed: " + e?.message,
              "background.injection",
            );
            sendResponse({ success: false, error: e?.message || String(e) });
          }
        } else {
          sendResponse({ success: false, error: "Action not supported" });
        }
        break;
      }
      default: {
        loggingHub.error("[BACKGROUND] DEFAULT: Action not supported", "background.message");
        sendResponse({ success: false, error: "Action not supported" });
      }
    }
  } catch (error) {
    loggingHub.error(
      "[BACKGROUND] Error handling " + action + ": " + error?.message,
      "background.message",
    );
    sendResponse({ success: false, error: error.message });
  }
  // Required for async response
  return true;
}
