/**
 * Dynamic Injection Script Loader
 * Fetches provider-specific injection scripts from the backend and executes them
 * This script is injected into the main world of the website
 */

(function () {
  "use strict";

  console.log("INJECTION SCRIPTS!!! LOADED!!!!");

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
      const keyValue = "reclaimProviderId";
      localStorage.setItem(keyValue, "7519ad78-208a-425d-9fac-97c13b0f0d4d");
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
          httpProviderId: providerId,
          name: "Unknown Provider",
        },
      };
    } catch (error) {
      debug.error(`Failed to fetch injection script for provider ${providerId}:`, error);
      return null;
    }
  }

  /**
   * Execute the fetched injection script safely
   */
  function executeInjectionScript(scriptContent, providerData) {
    try {
      debug.info(`Executing injection script for provider: ${providerData.name || "Unknown"}`);

      // Create a new function context to execute the script
      // This allows the script to access the page's globals while providing isolation
      const scriptFunction = new Function(
        "window",
        "document",
        "console",
        "localStorage",
        "sessionStorage",
        "providerData",
        scriptContent,
      );

      // Execute the script with current window context
      scriptFunction(window, document, console, localStorage, sessionStorage, providerData);

      debug.info(
        `Successfully executed injection script for provider: ${providerData.name || "Unknown"}`,
      );

      // Dispatch a custom event to notify that injection script has been executed
      window.dispatchEvent(
        new CustomEvent("reclaimInjectionScriptExecuted", {
          detail: {
            providerId: providerData.httpProviderId,
            providerName: providerData.name,
            timestamp: Date.now(),
          },
        }),
      );
    } catch (error) {
      debug.error(`Error executing injection script:`, error);

      // Dispatch error event
      window.dispatchEvent(
        new CustomEvent("reclaimInjectionScriptError", {
          detail: {
            providerId: providerData.httpProviderId,
            providerName: providerData.name,
            error: error.message,
            timestamp: Date.now(),
          },
        }),
      );
    }
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

      // Fetch the injection script from backend
      const injectionData = await fetchProviderInjectionScript(providerId);

      if (!injectionData) {
        debug.info("No injection script to execute");
        return;
      }

      // Execute the fetched script
      executeInjectionScript(injectionData.script, injectionData.providerData);
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
    executeInjectionScript,
  };

  // Initialize the loader
  debug.info("Reclaim Injection Script Loader initialized and injected successfully");
  initializeInjectionLoader();
})();
