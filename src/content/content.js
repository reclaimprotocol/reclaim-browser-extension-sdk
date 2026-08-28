import "../utils/polyfills";

import { RECLAIM_SDK_ACTIONS, MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../utils/constants";
import { createProviderVerificationPopup } from "./components/reclaim-provider-verification-popup";
// Imported from the module directly, not the ../utils/claim-creator barrel: the
// barrel also re-exports params-extractor, which pulls in the vendored attestor
// parsers (xpath/parse5/esprima). Those have import-time side effects
// (patch-parse5-tree mutates domhandler prototypes), so webpack cannot shake
// them out — and this bundle is injected at document_start on every page.
import {
  describeRequestMatch,
  MATCH_STAGES,
  MATCH_STAGE_ORDER,
} from "../utils/claim-creator/network-filter";
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
import { LOG_CONFIG_STORAGE_KEY, EVENT_TYPES } from "../utils/logger/constants";
import {
  NETWORK_FILTERING_TIMEOUT_MS,
  NETWORK_FILTERING_INTERVAL_MS,
  INTERCEPTED_DATA_MAX_AGE_MS,
  SESSION_TIMER_DURATION_MS,
} from "../utils/constants/config";

const logger = createRemoteLogger("content");

let shouldInitialize = false;
let interceptorInjected = false;
let injectionScriptInjected = false;

// Function to inject the network interceptor - will be called conditionally
const injectNetworkInterceptor = function () {
  if (interceptorInjected) return;

  try {
    const script = document.createElement("script");
    const src = chrome.runtime.getURL(
      "reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js",
    );
    script.src = src;
    script.type = "text/javascript";

    // Set highest priority attributes
    script.async = false;
    script.defer = false;

    // Try to inject as early as possible
    let injected = false;

    // Function to actually inject the script with highest priority
    const injectNow = () => {
      if (injected) return;

      if (document.documentElement) {
        // Use insertBefore for highest priority injection
        document.documentElement.insertBefore(script, document.documentElement.firstChild);
        injected = true;
        interceptorInjected = true;
      } else if (document.head) {
        document.head.insertBefore(script, document.head.firstChild);
        injected = true;
        interceptorInjected = true;
      } else if (document) {
        document.appendChild(script);
        injected = true;
        interceptorInjected = true;
      }
    };

    // Try to inject immediately
    injectNow();

    // Also set up a MutationObserver as a fallback
    if (!injected) {
      const observer = new MutationObserver(() => {
        if (!injected && (document.documentElement || document.head)) {
          injectNow();
          if (injected) {
            observer.disconnect();
          }
        }
      });

      // Observe document for any changes at the earliest possible moment
      observer.observe(document, { childList: true, subtree: true });
    }

    return script; // Return script element to prevent garbage collection
  } catch (e) {
    return null;
  }
};

// Function to inject the injection scripts - similar to network interceptor
const injectDynamicInjectionScript = function () {
  if (injectionScriptInjected) return;

  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(
      "reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js",
    );
    script.type = "text/javascript";

    // Set highest priority attributes
    script.async = false;
    script.defer = false;

    // Try to inject as early as possible
    let injected = false;

    // Function to actually inject the script with highest priority
    const injectNow = () => {
      if (injected) return;

      if (document.documentElement) {
        // Use insertBefore for highest priority injection
        document.documentElement.insertBefore(script, document.documentElement.firstChild);
        injected = true;
        injectionScriptInjected = true;
      } else if (document.head) {
        document.head.insertBefore(script, document.head.firstChild);
        injected = true;
        injectionScriptInjected = true;
      } else if (document) {
        document.appendChild(script);
        injected = true;
        injectionScriptInjected = true;
      }
    };

    // Try to inject immediately
    injectNow();

    // Also set up a MutationObserver as a fallback
    if (!injected) {
      const observer = new MutationObserver(() => {
        if (!injected && (document.documentElement || document.head)) {
          injectNow();
          if (injected) {
            observer.disconnect();
          }
        }
      });

      // Observe document for any changes at the earliest possible moment
      observer.observe(document, { childList: true, subtree: true });
    }

    return script; // Return script element to prevent garbage collection
  } catch (e) {
    return null;
  }
};

// Always forward proof completion/failure to the page, even in non-managed tabs
try {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, data } = message || {};
    if (action === MESSAGE_ACTIONS.PROOF_SUBMITTED) {
      try {
        const proofs = data?.formattedProofs || data?.proof || data;
        window.postMessage(
          {
            action: RECLAIM_SDK_ACTIONS.VERIFICATION_COMPLETED,
            messageId: data?.sessionId,
            data: { proofs },
          },
          "*",
        );
      } catch {}
      logger.info("[CONTENT] Proof submitted", "content.proof");
      sendResponse?.({ success: true });
      return true;
    }
    if (
      action === MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED ||
      action === MESSAGE_ACTIONS.PROOF_GENERATION_FAILED
    ) {
      try {
        window.postMessage(
          {
            action: RECLAIM_SDK_ACTIONS.VERIFICATION_FAILED,
            messageId: data?.sessionId,
            error: data?.error || "Verification failed",
          },
          "*",
        );
      } catch {}
      logger.info("[CONTENT] Proof submission failed", "content.proof");
      sendResponse?.({ success: true });
      return true;
    }
    return false;
  });
} catch {}

// On load, immediately check if this tab should be initialized
(async function () {
  try {
    // Early managed-tab check to inject interceptor only for verification tabs
    try {
      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.CHECK_IF_MANAGED_TAB,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: {},
        },
        (resp) => {
          // If this tab is managed, set the flag and inject immediately to catch login-time requests
          if (resp?.success && resp.isManaged) {
            shouldInitialize = true;

            if (resp.injectionType !== "NONE") {
              injectNetworkInterceptor();
            }
            injectDynamicInjectionScript();
          }
        },
      );
    } catch (e) {
      // ignore
    }
    // Notify background script that content script is loaded

    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.CONTENT_SCRIPT_LOADED,
      source: MESSAGE_SOURCES.CONTENT_SCRIPT,
      target: MESSAGE_SOURCES.BACKGROUND,
      data: { url: window.location.href },
    });

    // Listen for the background script's response about initialization
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const { action, data } = message;

      if (action === MESSAGE_ACTIONS.SHOULD_INITIALIZE) {
        shouldInitialize = data.shouldInitialize;

        if (shouldInitialize) {
          if (data.injectionType !== "NONE") {
            injectNetworkInterceptor();
          }
          injectDynamicInjectionScript();

          window.reclaimContentScript = new ReclaimContentScript();
        }

        sendResponse({ success: true });
      }

      return true;
    });
  } catch (e) {
    // Silent error handling
  }
})();

class ReclaimContentScript {
  constructor() {
    // The interceptor should be injected before this constructor runs
    this.init();

    // Only initialize popup-related properties if this is likely a managed tab
    // These will be properly set later during initialization
    this.verificationPopup = null;
    this.providerName = null;
    this.credentialType = null;
    this.dataRequired = null;

    this.interceptedRequestResponses = new Map();

    // Filtering state
    this.providerData = null;
    this.parameters = {};
    this.sessionId = null;
    this.providerId = null;
    this.appId = null;
    this.filteringInterval = null;
    this.filteringStartTime = null;
    this.filteredRequests = [];
    this.isFiltering = false;
    this.stopStoringInterceptions = false;

    // Match diagnostics. `matchProgress` maps "<matcherIndex>|<requestKey>" to
    // the furthest MATCH_STAGE_ORDER index that pair ever reached; filtering
    // re-runs every NETWORK_FILTERING_INTERVAL_MS over the same request map, so
    // logging on every evaluation would repeat each verdict for the life of the
    // session. Only an *advance* is reported.
    this.matchProgress = new Map();
    this.noMatchTimer = null;

    // Flag to track if this is a managed tab (will be set during init)
    this.isManagedTab = false;

    this._mode =
      typeof chrome !== "undefined" && chrome.runtime && location?.protocol === "chrome-extension:"
        ? "extension"
        : "web";
    if (this._mode === "extension") {
      this._boundChromeHandler = (message) => {
        const { action, data, error } = message || {};
        const messageId = data?.sessionId;
        if (!action || (this.sessionId && this.sessionId !== messageId)) return;
        if (action === "PROOF_SUBMITTED") {
          const proofs = data?.formattedProofs || data?.proof || data;
          this._emit("completed", proofs);
        } else if (action === "PROOF_SUBMISSION_FAILED" || action === "PROOF_GENERATION_FAILED") {
          this._emit("error", error || new Error("Verification failed"));
        }
      };
      try {
        chrome.runtime.onMessage.addListener(this._boundChromeHandler);
      } catch {}
    } else {
      this._boundWindowHandler = this.handleWindowMessage.bind(this);
      window.addEventListener("message", this._boundWindowHandler);
    }
  }

  /**
   * Push the log config down into the page world.
   *
   * The MAIN-world bridge cannot read chrome.storage, so without this its
   * console mirroring would ignore `consoleEnabled` entirely — which is how the
   * interceptor ended up logging on every page regardless of configuration.
   * Called once at init and again whenever the stored config changes.
   */
  pushLogConfigToPage(config) {
    if (config) this._lastLogConfig = config;
    try {
      window.postMessage({ action: RECLAIM_SDK_ACTIONS.LOG_CONFIG, data: { config } }, "*");
    } catch {
      // Nothing to do: the bridge falls back to its permissive defaults.
    }
  }

  /**
   * Keep the page world in sync with the stored log config.
   */
  watchLogConfig() {
    try {
      chrome.storage.local.get(LOG_CONFIG_STORAGE_KEY, (stored) => {
        const config = stored?.[LOG_CONFIG_STORAGE_KEY];
        if (config) this.pushLogConfigToPage(config);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[LOG_CONFIG_STORAGE_KEY]?.newValue) {
          this.pushLogConfigToPage(changes[LOG_CONFIG_STORAGE_KEY].newValue);
        }
      });
    } catch {
      // Storage unavailable in this context.
    }
  }

  init() {
    if (!shouldInitialize) {
      return;
    }

    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    this.watchLogConfig();

    // First verify this is a managed tab before proceeding with initialization
    chrome.runtime.sendMessage(
      {
        action: MESSAGE_ACTIONS.CHECK_IF_MANAGED_TAB,
        source: MESSAGE_SOURCES.CONTENT_SCRIPT,
        target: MESSAGE_SOURCES.BACKGROUND,
        data: {},
      },
      (response) => {
        if (!response.success || !response.isManaged) {
          // This tab is not managed by the extension, don't initialize popup-related functionality
          this.isManagedTab = false;
          return;
        }

        this.isManagedTab = true;

        // Only proceed with provider data request if this is a managed tab
        chrome.runtime.sendMessage(
          {
            action: MESSAGE_ACTIONS.REQUEST_PROVIDER_DATA,
            source: MESSAGE_SOURCES.CONTENT_SCRIPT,
            target: MESSAGE_SOURCES.BACKGROUND,
            data: { url: window.location.href },
          },
          (response) => {
            if (response.success) {
              this.providerData = response.data.providerData;
              this.parameters = response.data.parameters;
              this.sessionId = response.data.sessionId;
              this.providerId = response.data.providerId || "unknown";
              this.appId = response.data.appId || "unknown";

              logger.info(
                "[Content] Provider data received from background script",
                "content.provider",
              );

              if (!this.providerData?.disableRequestReplay) {
                chrome.runtime.sendMessage({
                  action: MESSAGE_ACTIONS.INJECT_VIA_SCRIPTING,
                  source: MESSAGE_SOURCES.CONTENT_SCRIPT,
                  target: MESSAGE_SOURCES.BACKGROUND,
                  data: { op: "REPLAY_PAGE_FETCH", showAlert: false },
                });
              }

              localStorage.setItem(
                "reclaimBrowserExtensionParameters",
                JSON.stringify(this.parameters || {}),
              );
              window.postMessage(
                {
                  action: RECLAIM_SDK_ACTIONS.PARAMETERS_UPDATE,
                  data: { parameters: this.parameters || {} },
                },
                "*",
              );

              // Store provider ID in website's localStorage for injection script access
              this.setProviderIdInLocalStorage(this.providerId);

              // Store injection script in website's localStorage for injection script access
              const hasCustomInjection = !!this.providerData?.customInjection?.length;
              const useChromeScripting =
                !!this.providerData?.extensionConfig?.allowInjectionsViaChromeScripting;
              logger.info(
                `[Content] customInjection: hasScript=${hasCustomInjection}, allowInjectionsViaChromeScripting=${useChromeScripting}, providerId=${this.providerId}`,
                "content.injection",
              );
              if (hasCustomInjection && useChromeScripting) {
                // Clear any stale localStorage value so injection-scripts.js doesn't double-inject
                localStorage.removeItem(
                  `reclaimBrowserExtensionInjectionScript:${this.providerId}`,
                );
                logger.info(
                  `[Content] Injecting via chrome.scripting.executeScript | providerId=${this.providerId}`,
                  "content.injection",
                );
                chrome.runtime.sendMessage({
                  action: MESSAGE_ACTIONS.INJECT_VIA_SCRIPTING,
                  source: MESSAGE_SOURCES.CONTENT_SCRIPT,
                  target: MESSAGE_SOURCES.BACKGROUND,
                  data: { op: "RUN_CUSTOM_INJECTION", code: this.providerData.customInjection },
                });
              } else {
                logger.info(
                  `[Content] Injecting via localStorage | hasScript=${hasCustomInjection}, providerId=${this.providerId}`,
                  "content.injection",
                );
                this.setProviderInjectionScriptInLocalStorage(
                  this.providerId,
                  this.providerData?.customInjection,
                );
              }

              if (!this.isFiltering) {
                this.startNetworkFiltering();
              }
              this.setupUrlListener();
            }
          },
        );
      },
    );
  }

  handleMessage(message, sender, sendResponse) {
    const { action, data, source } = message;

    switch (action) {
      case MESSAGE_ACTIONS.SHOULD_INITIALIZE:
        // ignore this message since we already handle it in the initialization check
        break;

      case MESSAGE_ACTIONS.PROVIDER_DATA_READY:
        // Only process provider data if this is a managed tab
        if (!this.isManagedTab) {
          // Not an exception: PROVIDER_DATA_READY is broadcast, so the content
          // script in the *originating* tab correctly declines it. Tagging this
          // TAB_NOT_MANAGED_BY_EXTENSION_EXCEPTION put an exception event in
          // every healthy session. The event stays on the real failure, where
          // messageRouter rejects a request from an unmanaged tab.
          logger.debug("[Content] Ignoring provider data: tab is not managed", "content.tab");
          sendResponse({ success: false, message: "Tab is not managed by extension" });
          break;
        }

        this.providerData = data.providerData;
        this.parameters = data.parameters;
        this.sessionId = data.sessionId;
        this.providerId = data.providerId || "unknown";
        this.appId = data.appId || "unknown";

        localStorage.setItem(
          "reclaimBrowserExtensionParameters",
          JSON.stringify(this.parameters || {}),
        );
        window.postMessage(
          {
            action: RECLAIM_SDK_ACTIONS.PARAMETERS_UPDATE,
            data: { parameters: this.parameters || {} },
          },
          "*",
        );

        // Store provider ID in website's localStorage for injection script access
        this.setProviderIdInLocalStorage(this.providerId);

        // Store injection script in website's localStorage for injection script access
        // Skip localStorage if chrome.scripting path is enabled (avoids duplicate injection via injection-scripts.js)
        const useChromeScriptingPDR =
          !!this.providerData?.extensionConfig?.allowInjectionsViaChromeScripting;
        logger.info(
          `[Content] PROVIDER_DATA_READY injection: allowInjectionsViaChromeScripting=${useChromeScriptingPDR}, hasScript=${!!data?.customInjection?.length}, providerId=${this.providerId}`,
          "content.injection",
        );
        if (!useChromeScriptingPDR) {
          this.setProviderInjectionScriptInLocalStorage(this.providerId, data?.customInjection);
        }

        if (!this.isFiltering) {
          this.startNetworkFiltering();
        }

        this.setupUrlListener();

        logger.info(
          "[Content] Provider data received, starting network filtering",
          "content.provider",
        );

        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.SHOW_PROVIDER_VERIFICATION_POPUP:
        // First check if this tab is managed by the extension before showing popup
        chrome.runtime.sendMessage(
          {
            action: MESSAGE_ACTIONS.CHECK_IF_MANAGED_TAB,
            source: MESSAGE_SOURCES.CONTENT_SCRIPT,
            target: MESSAGE_SOURCES.BACKGROUND,
            data: {},
          },
          (response) => {
            if (!response.success || !response.isManaged) {
              // This tab is not managed by the extension, don't show popup
              // Same as above: declining to draw the popup in an unmanaged
              // tab is the normal outcome, not an exception.
              logger.debug("[Content] Not showing popup: tab is not managed", "content.tab");
              sendResponse({ success: false, message: "Tab is not managed by extension" });
              return;
            }

            // Only proceed with popup creation if this is a managed tab
            if (this.verificationPopup) {
              try {
                logger.info("[Content] Removing existing popup", "content.popup");
                document.body.removeChild(this.verificationPopup.element);
              } catch (e) {
                // Silent error handling
              }
              this.verificationPopup = null;
            }

            this.providerName = data?.providerName || this.providerName;
            this.description = data?.description || this.description;
            this.dataRequired = data?.dataRequired || this.dataRequired;
            this.sessionId = data?.sessionId || this.sessionId;

            const appendPopupLogic = () => {
              if (!document.body) {
                return;
              }
              try {
                this.verificationPopup = createProviderVerificationPopup(
                  this.providerName,
                  this.description,
                  this.dataRequired,
                  this.sessionId,
                );
              } catch (e) {
                return;
              }

              try {
                setTimeout(() => {
                  document.body.appendChild(this.verificationPopup.element);
                }, 500);
              } catch (e) {
                return;
              }
            };

            if (document.readyState === "loading") {
              document.addEventListener(
                "DOMContentLoaded",
                () => {
                  appendPopupLogic();
                },
                { once: true },
              );
            } else {
              appendPopupLogic();
            }

            sendResponse({
              success: true,
              message: "Popup display process initiated and will proceed on DOM readiness.",
            });
          },
        );
        break;

      // Handle status update messages from background script
      case MESSAGE_ACTIONS.CLAIM_CREATION_REQUESTED:
        if (this.verificationPopup) {
          this.verificationPopup.handleClaimCreationRequested(data.requestHash, data.progress);
        }
        logger.info("[Content] Claim creation requested", "content.claim");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.CLAIM_CREATION_SUCCESS:
        if (this.verificationPopup) {
          this.verificationPopup.handleClaimCreationSuccess(data.requestHash);
        }
        logger.info("[Content] Claim creation success", "content.claim");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.CLAIM_CREATION_FAILED:
        if (this.verificationPopup) {
          this.verificationPopup.handleClaimCreationFailed(data.requestHash);
        }
        logger.info("[Content] Claim creation failed", "content.claim");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_GENERATION_STARTED:
        if (this.verificationPopup) {
          this.verificationPopup.handleProofGenerationStarted(data.requestHash);
        }
        logger.info("[Content] Proof generation started", "content.proof");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_GENERATION_SUCCESS:
        if (this.verificationPopup) {
          this.verificationPopup.handleProofGenerationSuccess(data.requestHash, data.progress);
        }
        logger.info("[Content] Proof generation success", "content.proof");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_GENERATION_FAILED:
        try {
          window.postMessage(
            {
              action: RECLAIM_SDK_ACTIONS.VERIFICATION_FAILED,
              messageId: data?.sessionId,
              error: data?.error || "Verification failed",
            },
            "*",
          );
        } catch (e) {
          // noop
        }
        if (this.verificationPopup) {
          this.verificationPopup.handleProofGenerationFailed(data.requestHash);
        }
        logger.info("[Content] Proof generation failed", "content.proof");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_SUBMITTED:
        try {
          const proofs = data?.formattedProofs || data?.proof || data;
          window.postMessage(
            {
              action: RECLAIM_SDK_ACTIONS.VERIFICATION_COMPLETED,
              messageId: data?.sessionId,
              data: { proofs },
            },
            "*",
          );
        } catch (e) {
          // noop
        }
        if (this.verificationPopup) {
          this.verificationPopup.handleProofSubmitted();
        }
        logger.info("[Content] Proof submitted", "content.proof");
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED:
        // Also forward failure to the page
        try {
          window.postMessage(
            {
              action: RECLAIM_SDK_ACTIONS.VERIFICATION_FAILED,
              messageId: data?.sessionId,
              error: data?.error || "Proof submission failed",
            },
            "*",
          );
        } catch (e) {
          // noop
        }
        if (this.verificationPopup) {
          this.verificationPopup.handleProofSubmissionFailed(data.error);
        }
        logger.info("[Content] Proof submission failed..", "content.proof");
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: "Unknown action" });
    }

    return true;
  }

  checkExtensionId(extensionID) {
    try {
      const runtimeId =
        typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id
          ? chrome.runtime.id
          : null;
      if (!extensionID) {
        // Non-strict mode: if caller didn't specify an ID, treat this extension as installed
        return !!runtimeId;
      }
      // Strict mode: only true if caller-supplied ID matches this extension's runtime ID
      return !!runtimeId && extensionID === runtimeId;
    } catch {
      return false;
    }
  }

  handleWindowMessage(event) {
    // Only accept messages from the same window
    if (event.source !== window) return;
    const { action, data, messageId, extensionID } = event.data;

    // MAIN-world log relay. The interceptor and injection scripts have no
    // chrome.runtime, so this is the only route their diagnostics have to the
    // hub. Relayed with the originating context, not "content", so the log
    // still says where interception actually failed.
    //
    // Deliberately not gated on extensionID: the bridge is a same-window
    // postMessage from our own injected script and carries no privileges. It
    // is gated on managed-tab status in the background's message router like
    // every other content-script message.
    if (action === RECLAIM_SDK_ACTIONS.LOG && data?.message) {
      logger.relay(data.message, data.type, data.level, data.context || "page", data.options);
      // Both this script and the page-world scripts start at document_start, so
      // the first config push can land before the bridge installed its
      // listener. The bridge's defaults are permissive, so nothing is lost —
      // but a consumer who disabled the console would still see page-world
      // logs. Re-send once, now that we know the bridge is listening.
      if (!this._logConfigEchoed && this._lastLogConfig) {
        this._logConfigEchoed = true;
        this.pushLogConfigToPage(this._lastLogConfig);
      }
      return;
    }

    // Check if the message is meant for this extension
    if (action === RECLAIM_SDK_ACTIONS.CHECK_EXTENSION) {
      // Send response back to the page
      // check if extensionId is present and is the same as the one in the env file
      if (!this.checkExtensionId(extensionID)) {
        return;
      }
      window.postMessage(
        {
          action: RECLAIM_SDK_ACTIONS.EXTENSION_RESPONSE,
          messageId: messageId,
          installed: true,
        },
        "*",
      );
    }

    if (action === "RECLAIM_GET_PROVIDER_ID" && event.data.source === "injection-script") {
      // Respond with the provider ID from extension context
      window.postMessage(
        {
          action: "RECLAIM_PROVIDER_ID_RESPONSE",
          providerId: this.providerId || null,
          source: "content-script",
        },
        "*",
      );
      return;
    }

    if (action === MESSAGE_ACTIONS.INTERCEPTED_REQUEST_AND_RESPONSE && data) {
      // Store the intercepted response

      const key = `${data.request.method}_${data.request.url}_${data.timestamp || Date.now()}`;
      this.interceptedRequestResponses.set(key, data);

      if (this.isFiltering) {
        this.startNetworkFiltering();
      }
    }

    // Handle start verification request from SDK
    if (action === RECLAIM_SDK_ACTIONS.START_VERIFICATION && data) {
      // Forward the template data to background script
      if (!this.checkExtensionId(extensionID)) {
        return;
      }
      logger.info("[Content] Starting verification with data from SDK", "content.verification", {
        eventType: EVENT_TYPES.WEB_PAGE_READY,
      });

      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.START_VERIFICATION,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: data,
        },
        (response) => {
          // Suppress chrome.runtime.lastError to avoid unchecked-lastError warnings.
          if (chrome.runtime.lastError) {
            logger.warn(
              "[Content] sendMessage port closed before response (MV3 SW timing): " +
                chrome.runtime.lastError.message,
              "content.message",
            );
          }

          // Store parameters and session ID for later use
          if (data.parameters) {
            this.parameters = data.parameters;
            localStorage.setItem(
              "reclaimBrowserExtensionParameters",
              JSON.stringify(this.parameters || {}),
            );
            window.postMessage(
              {
                action: RECLAIM_SDK_ACTIONS.PARAMETERS_UPDATE,
                data: { parameters: this.parameters || {} },
              },
              "*",
            );
          }

          if (data.sessionId) {
            this.sessionId = data.sessionId;
          }

          // This callback is ONLY used to signal VERIFICATION_STARTED.
          // We never fire VERIFICATION_FAILED here because the background
          // may still be running (MV3 SW timing, async fetchProviderData,
          // etc.). The real terminal outcome is delivered through separate
          // message channels: PROOF_SUBMITTED or PROOF_GENERATION_FAILED.
          if (response && response.success) {
            window.postMessage(
              {
                action: RECLAIM_SDK_ACTIONS.VERIFICATION_STARTED,
                messageId: messageId,
                sessionId: data.sessionId,
              },
              "*",
            );
          } else if (response && !response.success) {
            logger.warn(
              "[Content] START_VERIFICATION response indicated failure, awaiting terminal event: " +
                (response?.error || "unknown"),
              "content.verification",
            );
          } else {
            window.postMessage(
              {
                action: RECLAIM_SDK_ACTIONS.VERIFICATION_FAILED,
                messageId: messageId,
                error: response?.error || "Failed to start verification",
              },
              "*",
            );
            logger.error(
              "[Content] Verification failed: " + (response?.error || "Unknown error"),
              "content.verification",
            );
          }
        },
      );
    }

    if (action === RECLAIM_SDK_ACTIONS.CANCEL_VERIFICATION) {
      if (!this.checkExtensionId(extensionID)) {
        return;
      }
      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.CANCEL_VERIFICATION,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: { sessionId: this.sessionId },
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      logger.info("[Content] Verification cancelled", "content.verification");
    }

    if (action === RECLAIM_SDK_ACTIONS.SET_PUBLIC_DATA && data?.publicData !== null) {
      this.publicData = String(data?.publicData);
      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.UPDATE_PUBLIC_DATA,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: { publicData: this.publicData },
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      logger.info("[Content] Public data set", "content.data");
      return;
    }

    if (
      action === RECLAIM_SDK_ACTIONS.SET_EXPECT_MANY_CLAIMS &&
      typeof data?.expectMany === "boolean"
    ) {
      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.UPDATE_EXPECT_MANY_CLAIMS,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: { expectMany: !!data.expectMany },
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      logger.info("[Content] Expect many claims set", "content.claim");
      return;
    }

    if (action === RECLAIM_SDK_ACTIONS.PARAMETERS_GET) {
      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.GET_PARAMETERS,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: {},
        },
        (resp) => {
          const params = resp?.success ? resp.parameters || {} : this.parameters || {};
          this.parameters = params;
          localStorage.setItem(
            "reclaimBrowserExtensionParameters",
            JSON.stringify(this.parameters || {}),
          );
          window.postMessage(
            { action: RECLAIM_SDK_ACTIONS.PARAMETERS_UPDATE, data: { parameters: params } },
            "*",
          );
        },
      );
      // FINE: the background logs the same event, and a provider script can
      // call getParametersSync() on every render.
      logger.debug("[Content] Parameters get", "content.data");
      return;
    }

    // Whenever you set this.parameters (e.g., after REQUEST_PROVIDER_DATA, PROVIDER_DATA_READY, or SET_PARAMETERS), also:
    if (action === RECLAIM_SDK_ACTIONS.SET_PARAMETERS) {
      this.parameters = data?.parameters || {};
      localStorage.setItem(
        "reclaimBrowserExtensionParameters",
        JSON.stringify(this.parameters || {}),
      );
      window.postMessage(
        {
          action: RECLAIM_SDK_ACTIONS.PARAMETERS_UPDATE,
          data: { parameters: this.parameters || {} },
        },
        "*",
      );
    }

    // Handle log config updates from SDK
    if (action === RECLAIM_SDK_ACTIONS.SET_LOG_CONFIG && data?.config) {
      if (!this.checkExtensionId(extensionID)) {
        return;
      }
      const configMessageId = event.data?.messageId;
      try {
        // Store in storage for persistence
        chrome.storage.local.set({ [LOG_CONFIG_STORAGE_KEY]: data.config }, () => {
          // Also send directly to background to update LoggingHub immediately
          chrome.runtime.sendMessage(
            {
              action: MESSAGE_ACTIONS.UPDATE_LOG_CONFIG,
              source: MESSAGE_SOURCES.CONTENT_SCRIPT,
              target: MESSAGE_SOURCES.BACKGROUND,
              data: { config: data.config },
            },
            () => {
              // Send confirmation back to SDK
              window.postMessage(
                {
                  action: RECLAIM_SDK_ACTIONS.LOG_CONFIG_UPDATED,
                  messageId: configMessageId,
                  success: true,
                },
                "*",
              );
              logger.info("[Content] Log config updated", "content.config");
            },
          );
        });
      } catch (e) {
        // Send failure notification
        window.postMessage(
          {
            action: RECLAIM_SDK_ACTIONS.LOG_CONFIG_UPDATED,
            messageId: configMessageId,
            success: false,
            error: e?.message,
          },
          "*",
        );
        logger.error("[Content] Failed to update log config: " + e?.message, "content.config");
      }
      return;
    }

    if (action === RECLAIM_SDK_ACTIONS.REPORT_PROVIDER_ERROR && data?.message) {
      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.REPORT_PROVIDER_ERROR,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: { message: String(data.message) },
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      logger.info("[Content] Provider error reported", "content.provider");

      return;
    }

    if (action === RECLAIM_SDK_ACTIONS.REQUEST_CLAIM && data?.rdObject) {
      if (!this.sessionId) {
        // Either buffer or just fail-fast; simplest: log and return
        return;
      }
      const rdObject = data.rdObject || {};
      // Basic hash for status linkage
      const requestHash = `rc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Request format expected by createClaimObject path
      const request = {
        url: String(rdObject?.url || ""),
        method: String(rdObject?.method || "GET"),
        headers: rdObject?.headers || {},
        body: rdObject?.requestBody != null ? String(rdObject?.requestBody) : "",
        extractedParams: rdObject?.extractedParams || {},
      };

      // Minimal providerData-like criteria for createClaimObject
      const criteria = {
        url: String(rdObject?.url || ""),
        expectedPageUrl: "",
        urlType: "TEMPLATE",
        method: String(rdObject?.method || "GET"),
        responseMatches: Array.isArray(rdObject?.responseMatches) ? rdObject?.responseMatches : [],
        responseRedactions: Array.isArray(rdObject?.responseRedactions)
          ? rdObject?.responseRedactions
          : [],
        bodySniff: { enabled: false, template: "" },
        additionalClientOptions: {},
        requestHash,
      };
      if (rdObject?.writeRedactionMode) {
        criteria.writeRedactionMode = rdObject?.writeRedactionMode;
      }

      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.REQUEST_CLAIM,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: {
            request,
            criteria,
            sessionId: this.sessionId,
            loginUrl: this.providerData?.loginUrl || "",
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => {},
      );
      logger.info("[Content] Claim requested", "content.claim");
      return;
    }
  }

  cleanupInterceptedData() {
    const now = Date.now();
    const timeout = INTERCEPTED_DATA_MAX_AGE_MS;

    // Clean up linked data
    for (const [key, data] of this.interceptedRequestResponses.entries()) {
      if (now - data.timestamp > timeout) {
        this.interceptedRequestResponses.delete(key);
      }
    }
  }

  startNetworkFiltering() {
    if (!this.providerData) {
      return;
    }

    if (this.providerData?.injectionType === "NONE") {
      return;
    }

    this.isFiltering = true;
    this.filteringStartTime = Date.now();
    this.stopStoringInterceptions = false;
    this.matchProgress.clear();
    this.startNoMatchTimer();

    // Run filtering immediately
    this.filterInterceptedRequests();

    // Clear any existing interval before setting up a new one
    if (this.filteringInterval) {
      clearInterval(this.filteringInterval);
    }

    this.filteringInterval = setInterval(() => {
      // Skip if we've already found all requests
      if (this.stopStoringInterceptions) {
        this.stopNetworkFiltering();
        return;
      }

      this.filterInterceptedRequests();

      // Check for timeout (10 minutes)
      if (Date.now() - this.filteringStartTime > NETWORK_FILTERING_TIMEOUT_MS) {
        this.stopNetworkFiltering();
      }
    }, NETWORK_FILTERING_INTERVAL_MS);
  }

  stopNetworkFiltering() {
    if (this.filteringInterval) {
      clearInterval(this.filteringInterval);
      this.filteringInterval = null;
    }

    // Report before disarming: reaching NETWORK_FILTERING_TIMEOUT_MS with
    // nothing matched is exactly the case the summary exists for.
    if (this.filteredRequests.length === 0 && this.noMatchTimer) {
      this.reportNoMatchSummary();
    }
    this.clearNoMatchTimer();

    // Stop filtering flag
    this.isFiltering = false;

    // If we're stopping due to finding all requests, make sure we've properly
    // set the flag to stop storing intercepted data
    if (this.filteredRequests.length >= (this.providerData?.requestData?.length || 0)) {
      this.stopStoringInterceptions = true;

      // Clear stored data to free memory
      this.interceptedRequestResponses.clear();
    }
  }

  filterInterceptedRequests() {
    if (!this.providerData || !this.providerData.requestData) {
      return;
    }

    for (const [key, combinedData] of this.interceptedRequestResponses.entries()) {
      // Skip already filtered requests
      if (this.filteredRequests.includes(key)) {
        continue;
      }

      const requestValue = combinedData.request;
      const responseBody = combinedData.response.body;

      // Format request for filtering
      const formattedRequest = {
        url: requestValue.url,
        method: requestValue.method,
        body: requestValue.body || null,
        headers: requestValue.headers || {},
        responseText: responseBody,
        extractedParams: requestValue.extractedParams || {},
      };

      // Check against each criteria in provider data
      for (
        let matcherIndex = 0;
        matcherIndex < this.providerData.requestData.length;
        matcherIndex++
      ) {
        const criteria = this.providerData.requestData[matcherIndex];
        const verdict = describeRequestMatch(formattedRequest, criteria, this.parameters, logger);
        this.reportMatchAttempt(matcherIndex, key, formattedRequest, criteria, verdict);

        if (verdict.matched) {
          // Mark this request as filtered
          // Deliberately no eventType: the background's "Filtering request for
          // request hash" line already carries REQUEST_MATCHED, and it is the
          // authoritative one (it has the requestHash). Tagging this line too
          // double-counted the event — a 3-claim session reported 6.
          logger.info(
            "[Content] Matching request found: " +
              formattedRequest.method +
              " " +
              formattedRequest.url,
            "content.filter",
          );

          this.clearNoMatchTimer();
          this.filteredRequests.push(key);

          // Send to background script for cookie fetching and claim creation
          this.sendFilteredRequestToBackground(
            formattedRequest,
            criteria,
            this.providerData.loginUrl,
            key,
          );
        }
      }
    }

    if (this.filteredRequests.length >= this.providerData.requestData.length) {
      // Stop filtering and prevent further storage
      this.stopStoringInterceptions = true;
      this.isFiltering = false;

      if (this.filteringInterval) {
        clearInterval(this.filteringInterval);
        this.filteringInterval = null;
      }

      // Clear any other intervals or timeouts related to request handling
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      this.interceptedRequestResponses.clear();
    }
  }

  /**
   * Record how far one request got against one matcher, and log it the first
   * time it gets that far.
   *
   * Only *near misses* are logged individually. A plain url rejection is the
   * overwhelming majority — 32 of 33 requests in a typical page load — and says
   * nothing beyond "this wasn't the request", which the REQUEST_INTERCEPTED
   * line already covers. Anything past the url check means the provider very
   * nearly matched, which is the case worth a line: a stale bodySniff template
   * or a responseMatch that no longer holds is otherwise completely silent, and
   * the session dies on the timer looking like the user never logged in.
   *
   * Every url rejection is still counted, and surfaces in the timeout summary.
   */
  reportMatchAttempt(matcherIndex, requestKey, request, criteria, verdict) {
    const progressKey = `${matcherIndex}|${requestKey}`;
    const reached = MATCH_STAGE_ORDER.indexOf(verdict.stage);
    const furthest = this.matchProgress.get(progressKey);

    // A request is re-evaluated every tick, and can legitimately advance when
    // its response finally arrives. Report advances only.
    if (furthest !== undefined && reached <= furthest) return;
    this.matchProgress.set(progressKey, reached);

    if (verdict.matched || verdict.stage === MATCH_STAGES.URL) return;

    // `responseMissing` is the normal state on the tick between a request and
    // its response, so it is not worth an INFO line on its own.
    const level = verdict.stage === MATCH_STAGES.RESPONSE_MISSING ? "debug" : "info";

    logger[level](
      `[Content] Matcher #${matcherIndex} ▸ ${verdict.stage} did NOT match: ${verdict.detail} — ${request.method} ${request.url}`,
      "content.filter",
      {
        // The provider-authored templates that decided it. These are config,
        // not user data — but they go through the payload rather than the
        // message so they are capped and redaction still sees them.
        payload: {
          urlTemplate: criteria?.url,
          bodyTemplate: criteria?.bodySniff?.enabled ? criteria?.bodySniff?.template : undefined,
        },
      },
    );
  }

  /**
   * Arm the "nothing ever matched" timer.
   *
   * The background's SessionTimerManager only starts on the *first* intercepted
   * request, so it cannot distinguish "no traffic at all" from "plenty of
   * traffic, none of it matching" — which is why
   * RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION had no trigger. This
   * timer runs in the content script, where the counters live, and reports
   * whichever of the two actually happened.
   */
  startNoMatchTimer() {
    this.clearNoMatchTimer();
    this.noMatchTimer = setTimeout(() => {
      this.noMatchTimer = null;
      if (this.filteredRequests.length > 0) return;
      this.reportNoMatchSummary();
    }, SESSION_TIMER_DURATION_MS);
  }

  clearNoMatchTimer() {
    if (this.noMatchTimer) {
      clearTimeout(this.noMatchTimer);
      this.noMatchTimer = null;
    }
  }

  /** One line per matcher saying how far the closest request got. */
  reportNoMatchSummary() {
    const matchers = this.providerData?.requestData || [];
    const seconds = Math.round(SESSION_TIMER_DURATION_MS / 1000);

    // Tally the furthest stage each request reached, per matcher.
    const tallies = matchers.map(() => ({ seen: 0, past: MATCH_STAGE_ORDER.map(() => 0) }));
    for (const [progressKey, reached] of this.matchProgress.entries()) {
      const matcherIndex = Number(progressKey.split("|")[0]);
      const tally = tallies[matcherIndex];
      if (!tally) continue;
      tally.seen++;
      for (let stage = 0; stage <= reached; stage++) tally.past[stage]++;
    }

    const nothingSeen = tallies.every((tally) => tally.seen === 0);

    for (let i = 0; i < matchers.length; i++) {
      const tally = tallies[i] || { seen: 0, past: MATCH_STAGE_ORDER.map(() => 0) };
      const stageIndex = (stage) => MATCH_STAGE_ORDER.indexOf(stage);
      logger.info(
        `[Content] No request matched in ${seconds}s. Matcher #${i} (${matchers[i]?.method} ${matchers[i]?.url}): ` +
          // Reaching stage N means every check before N passed, so each count
          // is "url matched", "url+method matched", "url+method+body matched".
          `${tally.seen} seen, ${tally.past[stageIndex(MATCH_STAGES.METHOD)]} url-matched, ` +
          `${tally.past[stageIndex(MATCH_STAGES.BODY)]} method-matched, ` +
          `${tally.past[stageIndex(MATCH_STAGES.RESPONSE_MISSING)]} body-matched, ` +
          `${tally.past[stageIndex(MATCH_STAGES.MATCHED)]} fully matched`,
        "content.filter",
        {
          // NO_ACTIVITY is truthful only when nothing was intercepted at all —
          // this timer is what finally gives that upstream name a trigger. With
          // traffic seen the session did have activity, it just never produced
          // a claim, which is what the background's session timer already calls
          // CLAIM_CREATION_TIMED_OUT_EXCEPTION. Deliberately not
          // FILTER_REQUEST_ERROR: that marks a *thrown* filtering error, and
          // mixing a clean non-match into it would break that query.
          eventType: nothingSeen
            ? EVENT_TYPES.RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION
            : EVENT_TYPES.CLAIM_CREATION_TIMED_OUT_EXCEPTION,
        },
      );
    }
  }

  sendFilteredRequestToBackground(formattedRequest, matchingCriteria, loginUrl, requestKey) {
    logger.info(
      "[Content] Sending filtered request to background: " + formattedRequest.url,
      "content.filter",
    );

    chrome.runtime.sendMessage(
      {
        action: MESSAGE_ACTIONS.FILTERED_REQUEST_FOUND,
        source: MESSAGE_SOURCES.CONTENT_SCRIPT,
        target: MESSAGE_SOURCES.BACKGROUND,
        data: {
          request: formattedRequest,
          criteria: matchingCriteria,
          loginUrl: loginUrl,
          sessionId: this.sessionId,
        },
      },
      (response) => {
        // Background now owns authoritative xPath/jsonPath resolution, so it can
        // legitimately say "this response doesn't carry the data yet". Release
        // the key so a later response for the same request is filtered again;
        // without this the request stays marked as found and the flow stalls
        // until the session timer fires.
        if (response?.retryable && requestKey !== undefined) {
          const idx = this.filteredRequests.indexOf(requestKey);
          if (idx !== -1) {
            this.filteredRequests.splice(idx, 1);
          }
          logger.info(
            "[Content] Background could not resolve redactions yet, will keep filtering: " +
              formattedRequest.url,
            "content.filter",
          );
        }
      },
    );
  }

  setProviderIdInLocalStorage(providerId) {
    // Don't store null, undefined, or 'unknown' values
    const key = "reclaimBrowserExtensionProviderId";
    if (!providerId || providerId === "unknown") {
      localStorage.removeItem(key);
      logger.info(
        "[Content] Skipping localStorage storage for invalid provider ID: " + providerId,
        "content.storage",
      );
      return;
    }

    try {
      localStorage.setItem(key, providerId);
      logger.info(
        "[Content] Provider ID " + providerId + " stored in localStorage",
        "content.storage",
      );
    } catch (e) {
      localStorage.removeItem(key);
      logger.error(
        "[Content] Failed to store provider ID in localStorage: " + e.message,
        "content.storage",
      );
    }
  }

  // Helper method to store provider injection script in website's localStorage
  setProviderInjectionScriptInLocalStorage(providerId, injectionScript) {
    const key = `reclaimBrowserExtensionInjectionScript:${providerId}`;
    if (!providerId || providerId === "unknown") {
      localStorage.removeItem(key);
      logger.error("[Content] Failed to store provider ID in localStorage", "content.storage");

      return;
    }

    if (!injectionScript?.length) {
      localStorage.removeItem(key);
      // Most providers carry no customInjection at all, so this is the normal
      // path, not a failure. At ERROR it put an error line in every session for
      // every such provider, which trains you to ignore the level.
      logger.debug(
        "[Content] No injection script for this provider; nothing to store",
        "content.storage",
      );

      return;
    }

    try {
      localStorage.setItem(key, injectionScript);
      logger.info("[Content] Injection script stored in localStorage", "content.storage");
    } catch (e) {
      localStorage.removeItem(key);
      logger.error(
        "[Content] Failed to store injection script in localStorage: " + e.message,
        "content.storage",
      );
    }
  }

  setupUrlListener() {
    let lastUrl = window.location.href;

    // Watch for URL changes via DOM mutations
    const observer = new MutationObserver(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        // Your logic here
        if (!this.providerData?.disableRequestReplay) {
          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.INJECT_VIA_SCRIPTING,
            source: MESSAGE_SOURCES.CONTENT_SCRIPT,
            target: MESSAGE_SOURCES.BACKGROUND,
            data: { op: "REPLAY_PAGE_FETCH", showAlert: false },
          });
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

const contentScript = new ReclaimContentScript();
export default contentScript;
