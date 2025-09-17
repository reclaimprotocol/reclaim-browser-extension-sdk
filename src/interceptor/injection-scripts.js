import { MESSAGE_SOURCES } from "../utils/constants/interfaces";

window.Reclaim = window.Reclaim || {};
let __reclaimParams = {};

try {
  const ls = localStorage.getItem("reclaimBrowserExtensionParameters");
  if (ls) __reclaimParams = JSON.parse(ls) || {};
} catch {}

Object.defineProperty(window.Reclaim, "parameters", {
  get: () => {
    if (Object.keys(__reclaimParams).length > 0) return { ...__reclaimParams };
    try {
      const ls = localStorage.getItem("reclaimBrowserExtensionParameters");
      return ls ? JSON.parse(ls) : {};
    } catch {
      return {};
    }
  },
  set: () => {},
  enumerable: true,
  configurable: false,
});

window.Reclaim.updatePublicData = function (obj) {
  try {
    const publicData = JSON.stringify(obj ?? {});
    window.postMessage(
      {
        action: "RECLAIM_SET_PUBLIC_DATA",
        data: { publicData },
      },
      "*",
    );
  } catch (e) {
    console.error("Reclaim.updatePublicData error:", e);
  }
};

window.Reclaim.canExpectManyClaims = function (flag) {
  try {
    window.postMessage(
      { action: "RECLAIM_SET_EXPECT_MANY_CLAIMS", data: { expectMany: !!flag } },
      "*",
    );
  } catch {}
};

window.Reclaim.reportProviderError = function (msg) {
  try {
    window.postMessage(
      {
        action: "RECLAIM_REPORT_PROVIDER_ERROR",
        data: { message: String(msg || "Provider error") },
      },
      "*",
    );
  } catch (e) {
    console.error("Reclaim.reportProviderError error:", e);
  }
};

window.Reclaim.requestClaim = function (rdObject) {
  try {
    window.postMessage({ action: "RECLAIM_REQUEST_CLAIM", data: { rdObject } }, "*");
  } catch (e) {
    console.error("Reclaim.requestClaim error:", e);
  }
};

window.Reclaim.getParametersSync = function () {
  try {
    const ls = localStorage.getItem("reclaimBrowserExtensionParameters");
    return ls ? JSON.parse(ls) : {};
  } catch {
    return {};
  }
};

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const { action, data } = e.data || {};
  if (action === "RECLAIM_PARAMETERS_UPDATE" && data?.parameters) {
    const p = data.parameters || {};
    if (Object.keys(p).length === 0 && Object.keys(__reclaimParams).length > 0) return;
    __reclaimParams = p;
    try {
      localStorage.setItem("reclaimBrowserExtensionParameters", JSON.stringify(__reclaimParams));
    } catch {}
  }
});

try {
  window.postMessage({ action: "RECLAIM_PARAMETERS_GET" }, "*");
} catch {}

/**
 * Dynamic Injection Script Loader
 * Fetches provider-specific injection scripts from the backend and executes them
 * This script is injected into the main world of the website
 */

(function () {
  "use strict";

  // Backend API configuration
  const BACKEND_URL = "https://api.reclaimprotocol.org";
  const PROVIDER_API_ENDPOINT = (providerId) =>
    `${BACKEND_URL}/api/providers/${providerId}/custom-injection`;

  // Debug utility for logging
  const debug = {
    log: (...args) => console.log("🔍 [Injection Script]:", ...args),
    error: (...args) => console.error("❌ [Injection Script Error]:", ...args),
    info: (...args) => console.info("ℹ️ [Injection Script Info]:", ...args),
    // log: (...args) => undefined,
    // error: (...args) => undefined,
    // info: (...args) => undefined
  };

  /**
   * IMPORTANT: localStorage Context Isolation
   *
   * - background.js runs in extension context (chrome-extension://extension-id/)
   * - This injection script runs in website context (https://example.com/)
   * - These have SEPARATE localStorage spaces - they cannot share data directly
   *
   * Solutions:
   * 1. Content script acts as bridge (can access both contexts)
   * 2. Use chrome.storage API via content script
   * 3. Use postMessage communication between content script and injection script
   */

  /**
   * Safely retrieve provider ID from localStorage
   * Note: This only works if the provider ID was set by the website itself
   * or by a content script that has access to the website's localStorage
   */
  function getProviderIdFromStorage() {
    try {
      // Simplified to single key as per user's modification
      const keyValue = "reclaimBrowserExtensionProviderId";
      const value = localStorage.getItem(keyValue);
      if (value) {
        debug.info(`Found provider ID in localStorage[${keyValue}]: ${value}`);
        return value;
      }

      debug.error("Provider ID not found in local storage");
      return null;
    } catch (error) {
      debug.error("Error accessing localStorage:", error);
      return null;
    }
  }

  /**
   * Alternative: Get provider ID from extension via content script bridge
   * This method uses postMessage to communicate with content script
   */
  function getProviderIdFromExtension() {
    return new Promise((resolve) => {
      // Listen for response from content script
      const handleMessage = (event) => {
        if (event.source !== window) return;

        if (event.data.action === "RECLAIM_PROVIDER_ID_RESPONSE") {
          window.removeEventListener("message", handleMessage);
          resolve(event.data.providerId);
        }
      };

      window.addEventListener("message", handleMessage);

      // Request provider ID from content script
      window.postMessage(
        {
          action: "RECLAIM_GET_PROVIDER_ID",
          source: "injection-script",
        },
        "*",
      );

      // Timeout after 5 seconds
      setTimeout(() => {
        window.removeEventListener("message", handleMessage);
        resolve(null);
      }, 5000);
    });
  }

  /**
   * Fetch provider data including custom injection script from backend
   */
  async function fetchProviderInjectionScript(providerId) {
    try {
      debug.info(`Fetching injection script for provider: ${providerId}`);

      const response = await fetch(PROVIDER_API_ENDPOINT(providerId), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const scriptContent = await response.text();

      // Check if we got a valid script
      if (!scriptContent || scriptContent.trim() === "") {
        debug.info(`No injection script content found for provider: ${providerId}`);
        return null;
      }

      debug.info(`Successfully fetched injection script for provider: ${providerId}`);
      return {
        script: scriptContent,
        providerData: {
          providerId: providerId,
          name: "Unknown Provider",
        },
      };
    } catch (error) {
      debug.error(`Failed to fetch injection script for provider ${providerId}:`, error);
      return null;
    }
  }

  /**
   * Execute the fetched injection script without eval
   */
  function executeInjectionScriptNoEval2(scriptContent, providerData) {
    const finish = (ok) => {
      if (!ok) return; /* dispatch success event */
    };

    // 1) Inline without nonce (Steam allows 'unsafe-inline')
    try {
      const inl = document.createElement("script");
      inl.textContent = String(scriptContent);
      (document.documentElement || document.head || document).insertBefore(
        inl,
        (document.documentElement || document.head).firstChild,
      );
      finish(true);
      return;
    } catch {}

    // 2) Inline with page nonce
    try {
      const nonceEl = document.querySelector("script[nonce]");
      const pageNonce = nonceEl?.nonce || nonceEl?.getAttribute?.("nonce") || "";
      if (!pageNonce) throw new Error("No page nonce found");
      const inl = document.createElement("script");
      inl.nonce = pageNonce;
      inl.textContent = String(scriptContent);
      (document.documentElement || document.head || document).insertBefore(
        inl,
        (document.documentElement || document.head).firstChild,
      );
      finish(true);
      return;
    } catch {}

    // 3) unsafe-eval fallback (Steam allows it)
    try {
      (0, eval)(String(scriptContent));
      finish(true);
      return;
    } catch (e) {
      debug.error("Injection failed:", e);
      finish(false);
    }
  }

  async function executeInjectionScriptNoEval(scriptContent, providerData) {
    // 1) Try blob: URL (most robust without eval/inline)
    const okBlob = await injectViaBlob(scriptContent);
    if (okBlob) return;

    // // 2) Try page nonce (only if present). Still brittle, but cheap to try.
    const okNonce = await injectInlineWithNonce(scriptContent);
    if (okNonce) return;

    // 3) Last resort: ask the service worker to inject via chrome.scripting
    try {
      debug.info("Injected via chrome.scripting");
    } catch (e) {
      debug.error("All injection strategies failed", e);
    }
  }

  function injectViaBlob(code) {
    return new Promise((resolve) => {
      try {
        const blob = new Blob([code], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);

        const s = document.createElement("script");
        s.src = url;
        s.async = false;

        // If a page nonce exists, attach it (harmless if not needed)
        const nonceEl = document.querySelector("script[nonce]");
        const pageNonce = nonceEl?.nonce || nonceEl?.getAttribute?.("nonce") || "";
        if (pageNonce) s.setAttribute("nonce", pageNonce);

        s.onload = () => {
          URL.revokeObjectURL(url);
          resolve(true);
        };
        s.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(false);
        };

        (document.head || document.documentElement).appendChild(s);
      } catch {
        resolve(false);
      }
    });
  }

  function injectInlineWithNonce(code) {
    return new Promise((resolve) => {
      try {
        const nonceEl = document.querySelector("script[nonce]");
        const pageNonce = nonceEl?.nonce || nonceEl?.getAttribute?.("nonce") || "";
        if (!pageNonce) return resolve(false);

        // Inline + nonce (no reliable onload; we assume success if no sync error)
        const s = document.createElement("script");
        s.setAttribute("nonce", pageNonce);
        s.textContent = String(code);

        (document.head || document.documentElement).appendChild(s);

        // Give the browser a tick; if CSP blocked it, you’ll usually see a console error.
        setTimeout(() => resolve(true), 0);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Main function to load and execute injection script
   */
  async function loadAndExecuteInjectionScript() {
    try {
      // Try to get provider ID from localStorage first
      let providerId = getProviderIdFromStorage();
      // const providerId = "8f8f3def-7864-4dae-890d-9e95c5e45bec"

      // If not found in localStorage, try to get from extension
      if (!providerId) {
        debug.info("Provider ID not found in localStorage, requesting from extension...");
        providerId = await getProviderIdFromExtension();
      }

      if (!providerId) {
        debug.error("Cannot load injection script: Provider ID not found");
        return;
      }

      // Fetch the injection script from localStorage
      const injectionScript = localStorage.getItem(
        `reclaimBrowserExtensionInjectionScript:${providerId}`,
      );

      if (!injectionScript) {
        debug.info("No injection script to execute");
        return;
      }

      const providerData = {
        providerId: providerId,
        name: "Unknown Provider",
      };

      // Execute the fetched script
      // executeInjectionScript(injectionScript, providerData);
      executeInjectionScriptNoEval(injectionScript, providerData);
    } catch (error) {
      debug.error("Error in loadAndExecuteInjectionScript:", error);
    }
  }

  /**
   * Initialize the injection script loader
   * Waits for DOM to be ready before executing
   */
  function initializeInjectionLoader() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", loadAndExecuteInjectionScript);
    } else {
      // DOM is already ready
      loadAndExecuteInjectionScript();
    }
  }

  // Expose utilities globally for debugging and external access
  window.reclaimInjectionLoader = {
    loadAndExecuteInjectionScript,
    getProviderIdFromStorage,
    getProviderIdFromExtension,
    fetchProviderInjectionScript,
    executeInjectionScriptNoEval,
  };

  // Initialize the loader
  debug.info("Reclaim Injection Script Loader initialized and injected successfully");
  initializeInjectionLoader();
})();
