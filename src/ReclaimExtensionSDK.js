import "./utils/polyfills";
import initBackground from "./background/background";
import { BACKEND_URL, API_ENDPOINTS, RECLAIM_SDK_ACTIONS } from "./utils/constants";
import { Wallet, keccak256, getBytes } from "ethers";

// Global verification queue to serialize extension sessions (background is single-session)
const _verificationQueue = [];
let _queueRunning = false;
const SDK_VERSION = "0.0.1";

function _enqueueVerification(task) {
  return new Promise((resolve, reject) => {
    _verificationQueue.push({ task, resolve, reject });
    _drainQueue();
  });
}

async function _drainQueue() {
  if (_queueRunning) return;
  const next = _verificationQueue.shift();
  if (!next) return;
  _queueRunning = true;
  try {
    const result = await next.task();
    next.resolve(result);
  } catch (e) {
    next.reject(e);
  } finally {
    _queueRunning = false;
    _drainQueue();
  }
}

class ReclaimExtensionProofRequest {
  constructor(applicationId, providerId, options = {}) {
    this.applicationId = applicationId;
    this.providerId = providerId;
    this.sessionId = "";
    this.signature = "";
    this.timestamp = Date.now().toString();
    this.parameters = {};
    this.context = { contextAddress: "0x0", contextMessage: "sample context" };
    this.redirectUrl = "";
    this.sdkVersion = `ext-${SDK_VERSION}`;
    this.resolvedProviderVersion = "";
    this.jsonProofResponse = false;
    this.extensionID = options.extensionID || "";
    this.providerVersion = options.providerVersion || "";
    this.acceptAiProviders = !!options.acceptAiProviders;
    this.callbackUrl = options.callbackUrl || "";

    this._backgroundInitialized = false;
    this._ctx = null;

    this._listeners = {
      started: new Set(),
      completed: new Set(),
      error: new Set(),
      progress: new Set(),
    };
    this._boundWindowListener = this._handleWindowMessage.bind(this);
    window.addEventListener("message", this._boundWindowListener);

    this._mode =
      typeof chrome !== "undefined" && chrome.runtime && location?.protocol === "chrome-extension:"
        ? "extension"
        : "web";
    // No global runtime listener here. Each ReclaimExtensionProofRequest instance already listens and emits.
    if (this._mode === "extension") {
      this._boundChromeHandler = (message) => {
        const { action, data, error } = message || {};
        const messageId = data?.sessionId;
        if (this.sessionId && this.sessionId !== messageId) return;
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
    }
  }

  static async init(applicationId, appSecret, providerId, options = {}) {
    if (!applicationId || typeof applicationId !== "string") {
      throw new Error("applicationId must be a non-empty string");
    }
    if (!appSecret || typeof appSecret !== "string") {
      throw new Error("appSecret must be a non-empty string");
    }
    if (!providerId || typeof providerId !== "string") {
      throw new Error("providerId must be a non-empty string");
    }

    const instance = new ReclaimExtensionProofRequest(applicationId, providerId, options);

    // Generate signature over canonicalized { providerId, timestamp }
    const canonical = `{"providerId":"${providerId}","timestamp":"${instance.timestamp}"}`;
    const hash = keccak256(new TextEncoder().encode(canonical));
    const wallet = new Wallet(appSecret);
    const signature = await wallet.signMessage(getBytes(hash));
    instance.signature = signature;

    // Init session on backend
    const initRes = await instance._initSession({
      providerId,
      appId: applicationId,
      timestamp: instance.timestamp,
      signature,
      versionNumber: instance.providerVersion || "",
    });
    instance.sessionId = initRes.sessionId || "";
    instance.resolvedProviderVersion = initRes.resolvedProviderVersion || "";
    console.log("instance from init", instance);
    return instance;
  }

  static fromJsonString(json, options = {}) {
    const cfg = typeof json === "string" ? JSON.parse(json) : json;
    return this.fromConfig(cfg, options);
  }

  static fromConfig(config, options = {}) {
    if (!config || typeof config !== "object") throw new Error("invalid config");
    const instance = new ReclaimExtensionProofRequest(
      String(config.applicationId || ""),
      String(config.providerId || ""),
      options || {},
    );

    instance.sessionId = String(config.sessionId || "");
    instance.signature = String(config.signature || "");
    instance.timestamp = String(config.timeStamp || config.timestamp || Date.now());
    instance.parameters = config.parameters || {};
    instance.context = config.context || instance.context;
    instance.callbackUrl = String(config.appCallbackUrl || config.callbackUrl || "");
    instance.jsonProofResponse = !!(config.jsonProofResponse ?? instance.jsonProofResponse);
    instance.resolvedProviderVersion = String(config.resolvedProviderVersion || "");
    instance.providerVersion = String(config.providerVersion || "");
    instance.redirectUrl = String(config.redirectUrl || "");
    instance.acceptAiProviders = !!(
      config.acceptAiProviders ??
      config.options?.acceptAiProviders ??
      instance.acceptAiProviders
    );

    if (options?.extensionID) instance.extensionID = String(options.extensionID);

    // Keep sdkVersion as ext-* (do not trust inbound js sdkVersion)
    // instance.sdkVersion already set to ext-<version>
    console.log("instance from fromConfig", instance);
    return instance;
  }

  // Configuration helpers
  setAppCallbackUrl(url, jsonProofResponse = false) {
    if (!url || typeof url !== "string") throw new Error("callbackUrl must be a non-empty string");
    this.callbackUrl = url;
    this.jsonProofResponse = !!jsonProofResponse;
  }

  setRedirectUrl(url) {
    if (!url || typeof url !== "string") throw new Error("redirectUrl must be a non-empty string");
    this.redirectUrl = url;
  }

  addContext(address, message) {
    if (!address || !message) throw new Error("Both address and message are required");
    this.context = { contextAddress: String(address), contextMessage: String(message) };
  }

  setParams(params) {
    if (!params || typeof params !== "object") throw new Error("params must be an object");
    this.parameters = { ...this.parameters, ...params };
  }

  getStatusUrl() {
    if (!this.sessionId) throw new Error("Session not initialized");
    if (API_ENDPOINTS?.STATUS_URL) {
      return API_ENDPOINTS.STATUS_URL(this.sessionId);
    }
    return `${BACKEND_URL}/api/sdk/status/${this.sessionId}`;
  }

  // Events
  on(event, cb) {
    if (!this._listeners[event]) throw new Error(`Unknown event: ${event}`);
    this._listeners[event].add(cb);
    return () => this.off(event, cb);
  }
  off(event, cb) {
    if (!this._listeners[event]) return;
    this._listeners[event].delete(cb);
  }

  // Public API: start verification
  async startVerification() {
    return _enqueueVerification(() => this._startVerificationInternal());
  }

  async cancel(timeoutMs = 5000) {
    if (!this.sessionId) return;
    // Wait for VERIFICATION_FAILED propagated from content on cancel
    return new Promise((resolve) => {
      let done = false;
      const offErr = this.on("error", () => {
        if (!done) {
          done = true;
          offErr();
          resolve(true);
        }
      });
      // Post cancel
      window.postMessage(
        {
          action: RECLAIM_SDK_ACTIONS.CANCEL_VERIFICATION,
          messageId: this.sessionId,
          extensionID: this.extensionID,
        },
        "*",
      );
      // Fallback timeout
      setTimeout(() => {
        if (!done) {
          offErr();
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  // Internals
  async _startVerificationInternal() {
    if (!this.sessionId) throw new Error("Session not initialized");
    if (!this.signature) throw new Error("Signature not set");

    const templateData = {
      sessionId: this.sessionId,
      providerId: this.providerId,
      applicationId: this.applicationId,
      signature: this.signature,
      timestamp: this.timestamp,
      callbackUrl: this.callbackUrl || "",
      context: JSON.stringify(this.context || {}),
      parameters: this.parameters || {},
      redirectUrl: this.redirectUrl || "",
      acceptAiProviders: !!this.acceptAiProviders,
      sdkVersion: this.sdkVersion,
      providerVersion: this.providerVersion || "",
      resolvedProviderVersion: this.resolvedProviderVersion || "",
      jsonProofResponse: !!this.jsonProofResponse,
    };

    const messageId = this.sessionId;

    // One-shot Promise around events
    return new Promise((resolve, reject) => {
      const offStarted = this.on("started", () => {});
      const offCompleted = this.on("completed", (payload) => {
        cleanup();
        resolve(payload);
      });
      const offError = this.on("error", (err) => {
        cleanup();
        reject(err);
      });
      const cleanup = () => {
        offStarted && offStarted();
        offCompleted && offCompleted();
        offError && offError();
      };

      // choose path based on SDK mode, not on chrome.runtime presence
      if (this._mode === "extension") {
        try {
          chrome.runtime.sendMessage(
            {
              action: "START_VERIFICATION",
              source: "content-script",
              target: "background",
              data: templateData,
            },
            (resp) => {
              if (resp && resp.success)
                this._emit("started", { sessionId: this.sessionId, messageId });
            },
          );
        } catch (e) {
          this._emit("error", e instanceof Error ? e : new Error(String(e)));
        }
      } else {
        // web page → talk to the injected content script via window.postMessage
        if (!this.extensionID) {
          this._emit("error", new Error("extensionID is required when running on a web page"));
          return;
        }
        window.postMessage(
          {
            action: RECLAIM_SDK_ACTIONS.START_VERIFICATION,
            messageId,
            data: templateData,
            extensionID: this.extensionID,
          },
          "*",
        );
      }
    });
  }

  dispose() {
    window.removeEventListener("message", this._boundWindowListener);
    if (this._boundChromeHandler && chrome?.runtime?.onMessage?.removeListener) {
      try {
        chrome.runtime.onMessage.removeListener(this._boundChromeHandler);
      } catch {}
    }
    this._listeners.started.clear();
    this._listeners.completed.clear();
    this._listeners.error.clear();
    this._listeners.progress.clear();
  }

  async _initSession(payload) {
    const res = await fetch(`${BACKEND_URL}/api/sdk/init/session/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || "Failed to initialize session");
    return data;
  }

  _emit(event, payload) {
    if (!this._listeners[event]) return;
    for (const cb of this._listeners[event]) {
      try {
        cb(payload);
      } catch (_) {}
    }
  }

  _handleWindowMessage(event) {
    if (event.source !== window) return;
    const { action, messageId, data, error } = event.data || {};
    const isForMe = !this.sessionId || this.sessionId === messageId;
    if (!isForMe) return;

    if (action === RECLAIM_SDK_ACTIONS.VERIFICATION_COMPLETED) {
      const proofs = data?.proofs || data?.formattedProofs || data;
      this._emit("completed", proofs);
      return;
    }
    if (action === RECLAIM_SDK_ACTIONS.VERIFICATION_FAILED) {
      this._emit("error", error || new Error("Verification failed"));
      return;
    }
    if (action === RECLAIM_SDK_ACTIONS.VERIFICATION_STARTED) {
      this._emit("started", { sessionId: this.sessionId, messageId });
      return;
    }
  }
}

class ReclaimExtensionSDK {
  constructor() {
    this._backgroundInitialized = false;
    this._ctx = null;
    this._mode =
      typeof chrome !== "undefined" && chrome.runtime && location?.protocol === "chrome-extension:"
        ? "extension"
        : "web";
    // if (this._mode === "extension") {
    //   this._boundChromeHandler = (message) => {
    //     const { action, data, error } = message || {};
    //     const messageId = data?.sessionId;
    //     if (!action || (this.sessionId && this.sessionId !== messageId)) return;
    //     if (action === "PROOF_SUBMITTED") {
    //       const proofs = data?.formattedProofs || data?.proof || data;
    //       this._emit("completed", proofs);
    //     } else if (action === "PROOF_SUBMISSION_FAILED" || action === "PROOF_GENERATION_FAILED") {
    //       this._emit("error", error || new Error("Verification failed"));
    //     }
    //   };
    //   try {
    //     chrome.runtime.onMessage.addListener(this._boundChromeHandler);
    //   } catch {}
    // }
  }

  // Must be called from the consumer's own background service worker.
  initializeBackground() {
    if (this._backgroundInitialized) return this._ctx;
    try {
      const ctx = initBackground();
      this._backgroundInitialized = true;
      this._ctx = ctx;
      return ctx;
    } catch (error) {
      throw error;
    }
  }

  // Check if extension is installed and matches extensionID
  isExtensionInstalled({ extensionID, timeout = 500 } = {}) {
    return new Promise((resolve) => {
      const messageId = `reclaim-check-${Date.now()}`;
      const handler = (event) => {
        if (
          event.source === window &&
          event.data?.action === RECLAIM_SDK_ACTIONS.EXTENSION_RESPONSE &&
          event.data?.messageId === messageId
        ) {
          window.removeEventListener("message", handler);
          resolve(!!event.data.installed);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage(
        { action: RECLAIM_SDK_ACTIONS.CHECK_EXTENSION, extensionID, messageId },
        "*",
      );
      setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(false);
      }, timeout);
    });
  }

  getVersion() {
    return SDK_VERSION;
  }

  // Primary API: create a per-request instance
  async init(applicationId, appSecret, providerId, options = {}) {
    return await ReclaimExtensionProofRequest.init(applicationId, appSecret, providerId, options);
  }

  fromJsonString(json, options = {}) {
    return ReclaimExtensionProofRequest.fromJsonString(json, options);
  }
}

export const reclaimExtensionSDK = new ReclaimExtensionSDK();
export { ReclaimExtensionProofRequest };
export default ReclaimExtensionSDK;
