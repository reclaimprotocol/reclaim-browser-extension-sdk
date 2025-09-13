// Import polyfills
import "../utils/polyfills";

import { RECLAIM_SDK_ACTIONS, MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../utils/constants";
import { createProviderVerificationPopup } from "./components/reclaim-provider-verification-popup";
import { filterRequest } from "../utils/claim-creator";
import { loggerService, createContextLogger } from "../utils/logger/LoggerService";
import { LOG_TYPES, LOG_LEVEL } from "../utils/logger/constants";

// Default: INFO+ to console and backend
loggerService.setConfig({
  consoleEnabled: true,
  backendEnabled: true,
  consoleLevel: LOG_LEVEL.INFO,
  backendLevel: LOG_LEVEL.INFO,
  includeSensitiveToBackend: false,
  debugMode: false, // set true to print every log to console
});

const logger = createContextLogger({
  sessionId: "unknown",
  providerId: "unknown",
  appId: "unknown",
  source: "reclaim-extension-sdk",
});

// Create a flag to track if we should initialize
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

            injectNetworkInterceptor(); // safe: guarded by interceptorInjected
            // Optional: if you also want the extra script:
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
          // If we should initialize, inject the interceptor immediately
          injectNetworkInterceptor();

          // Also inject the dynamic injection script loader
          injectDynamicInjectionScript();

          // And initialize the content script
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

    // Storage for intercepted requests and responses
    this.interceptedRequestResponses = new Map();

    // Filtering state
    this.providerData = null;
    this.parameters = {};
    this.sessionId = null;
    this.httpProviderId = null;
    this.appId = null;
    this.filteringInterval = null;
    this.filteringStartTime = null;
    this.filteredRequests = [];
    this.isFiltering = false;
    this.stopStoringInterceptions = false;

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

  init() {
    // Listen for messages from the web page
    // window.addEventListener("message", this.handleWindowMessage.bind(this));

    if (!shouldInitialize) {
      return;
    }

    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));

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

        // Mark this as a managed tab
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
              this.httpProviderId = response.data.httpProviderId || "unknown";
              this.appId = response.data.appId || "unknown";

              logger.setContext({
                sessionId: this.sessionId,
                providerId: this.httpProviderId,
                appId: this.appId,
                type: LOG_TYPES.CONTENT,
              });

              logger.info(
                "[Content] Provider data received from background script and will proceed with network filtering.",
              );

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
              this.setProviderIdInLocalStorage(this.httpProviderId);

              // Store injection script in website's localStorage for injection script access
              this.setProviderInjectionScriptInLocalStorage(
                this.httpProviderId,
                this.providerData?.customInjection,
              );

              if (!this.isFiltering) {
                this.startNetworkFiltering();
              }
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
          sendResponse({ success: false, message: "Tab is not managed by extension" });
          break;
        }

        this.providerData = data.providerData;
        this.parameters = data.parameters;
        this.sessionId = data.sessionId;
        this.httpProviderId = data.httpProviderId || "unknown";
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
        this.setProviderIdInLocalStorage(this.httpProviderId);

        // Store injection script in website's localStorage for injection script access
        this.setProviderInjectionScriptInLocalStorage(this.httpProviderId, data?.customInjection);

        if (!this.isFiltering) {
          this.startNetworkFiltering();
        }

        logger.info(
          "[Content] Provider data received from background script and will proceed with network filtering.",
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
              sendResponse({ success: false, message: "Tab is not managed by extension" });
              return;
            }

            // Only proceed with popup creation if this is a managed tab
            if (this.verificationPopup) {
              try {
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
                document.body.appendChild(this.verificationPopup.element);
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

            if (this.appId && this.httpProviderId && this.sessionId) {
              logger.info(
                "[Content] Popup display process initiated and will proceed on DOM readiness.",
              );
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
          this.verificationPopup.handleClaimCreationRequested(data.requestHash);
        }
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.CLAIM_CREATION_SUCCESS:
        if (this.verificationPopup) {
          this.verificationPopup.handleClaimCreationSuccess(data.requestHash);
        }
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.CLAIM_CREATION_FAILED:
        if (this.verificationPopup) {
          this.verificationPopup.handleClaimCreationFailed(data.requestHash);
        }
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_GENERATION_STARTED:
        if (this.verificationPopup) {
          this.verificationPopup.handleProofGenerationStarted(data.requestHash);
        }
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.PROOF_GENERATION_SUCCESS:
        if (this.verificationPopup) {
          this.verificationPopup.handleProofGenerationSuccess(data.requestHash);
        }
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
      // Strict mode: only true if caller-supplied ID matches this extension’s runtime ID
      return !!runtimeId && extensionID === runtimeId;
    } catch {
      return false;
    }
  }

  handleWindowMessage(event) {
    // Only accept messages from the same window
    if (event.source !== window) return;
    const { action, data, messageId, extensionID } = event.data;

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

    // Handle provider ID request from injection script
    if (action === "RECLAIM_GET_PROVIDER_ID" && event.data.source === "injection-script") {
      // Respond with the provider ID from extension context
      window.postMessage(
        {
          action: "RECLAIM_PROVIDER_ID_RESPONSE",
          providerId: this.httpProviderId || null,
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

      if (data?.response?.body?.includes("follower_count")) {
        console.log("data from INTERCEPTED_REQUEST_AND_RESPONSE", { data, key });
      }

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
      logger.info("[Content] Starting verification with data from SDK: " + JSON.stringify(data));

      chrome.runtime.sendMessage(
        {
          action: MESSAGE_ACTIONS.START_VERIFICATION,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: data,
        },
        (response) => {
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

          // Send confirmation back to SDK
          if (response && response.success) {
            window.postMessage(
              {
                action: RECLAIM_SDK_ACTIONS.VERIFICATION_STARTED,
                messageId: messageId,
                sessionId: data.sessionId,
              },
              "*",
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
      return;
    }
  }

  // Clean up old intercepted data
  cleanupInterceptedData() {
    const now = Date.now();
    const timeout = 2 * 60 * 1000; // 2 minutes

    // Clean up linked data
    for (const [key, data] of this.interceptedRequestResponses.entries()) {
      if (now - data.timestamp > timeout) {
        this.interceptedRequestResponses.delete(key);
      }
    }
  }

  // Start filtering intercepted network requests
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

    // Run filtering immediately
    this.filterInterceptedRequests();

    // Clear any existing interval before setting up a new one
    if (this.filteringInterval) {
      clearInterval(this.filteringInterval);
    }

    // Then set up interval for continuous filtering
    this.filteringInterval = setInterval(() => {
      // Skip if we've already found all requests
      if (this.stopStoringInterceptions) {
        this.stopNetworkFiltering();
        return;
      }

      this.filterInterceptedRequests();

      // Check for timeout (10 minutes)
      if (Date.now() - this.filteringStartTime > 10 * 60 * 1000) {
        this.stopNetworkFiltering();
      }
    }, 1000);
  }

  // Stop network filtering
  stopNetworkFiltering() {
    // Clear the filtering interval
    if (this.filteringInterval) {
      clearInterval(this.filteringInterval);
      this.filteringInterval = null;
    }

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

  // Filter intercepted requests with provider criteria
  filterInterceptedRequests() {
    if (!this.providerData || !this.providerData.requestData) {
      return;
    }

    // For each linked request/response pair
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
      };

      // Check against each criteria in provider data
      for (const criteria of this.providerData.requestData) {
        if (filterRequest(formattedRequest, criteria, this.parameters)) {
          // Mark this request as filtered
          logger.info(
            "[Content] Matching request found: " +
              formattedRequest.method +
              " " +
              formattedRequest.url,
          );

          this.filteredRequests.push(key);

          // Send to background script for cookie fetching and claim creation
          this.sendFilteredRequestToBackground(
            formattedRequest,
            criteria,
            this.providerData.loginUrl,
          );
        }
      }
    }

    // If we've found all possible matching requests, stop filtering
    if (this.filteredRequests.length >= this.providerData.requestData.length) {
      logger.info(
        "[Content] Found all matching requests, stopping filtering and cleaning up resources",
      );

      // Stop filtering and prevent further storage
      this.stopStoringInterceptions = true;
      this.isFiltering = false;

      // Clear filtering interval
      if (this.filteringInterval) {
        clearInterval(this.filteringInterval);
        this.filteringInterval = null;
      }

      // Clear any other intervals or timeouts related to request handling
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      // Clear all stored requests and responses
      this.interceptedRequestResponses.clear();
    }
  }

  // Send filtered request to background script
  sendFilteredRequestToBackground(formattedRequest, matchingCriteria, loginUrl) {
    logger.info(
      "[Content] Sending filtered request to background script: " +
        JSON.stringify(formattedRequest.url),
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
        // Background response handled silently
      },
    );
  }

  // Helper method to store provider ID in website's localStorage
  setProviderIdInLocalStorage(providerId) {
    // Don't store null, undefined, or 'unknown' values
    const key = "reclaimBrowserExtensionProviderId";
    if (!providerId || providerId === "unknown") {
      localStorage.removeItem(key);
      logger.info("[Content] Skipping localStorage storage for invalid provider ID: " + providerId);
      return;
    }

    try {
      localStorage.setItem(key, providerId);
      logger.info("[Content] Provider ID " + providerId + " stored in localStorage.");
    } catch (e) {
      localStorage.removeItem(key);
      logger.error(
        "[Content] Failed to store provider ID " + providerId + " in localStorage: " + e.message,
      );
    }
  }

  // Helper method to store provider injection script in website's localStorage
  setProviderInjectionScriptInLocalStorage(providerId, injectionScript) {
    const key = `reclaimBrowserExtensionInjectionScript:${providerId}`;
    if (!providerId || providerId === "unknown") {
      localStorage.removeItem(key);
      logger.error("[Content] Failed to store provider ID " + providerId + " in localStorage: ");

      return;
    }

    if (!injectionScript?.length) {
      localStorage.removeItem(key);
      logger.error("[Content] Skipping localStorage storage for injection script");

      return;
    }

    try {
      localStorage.setItem(key, injectionScript);
      logger.info("[Content] Injection script stored in localStorage.");
    } catch (e) {
      localStorage.removeItem(key);
      logger.error("[Content] Failed to store injection script in localStorage: " + e.message);
    }
  }
}

// Initialize content script
const contentScript = new ReclaimContentScript();
export default contentScript;
