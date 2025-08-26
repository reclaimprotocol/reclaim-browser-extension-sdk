// Import polyfills
import "../utils/polyfills";

// Import necessary utilities and libraries
import {
  fetchProviderData,
  updateSessionStatus,
  submitProofOnCallback,
} from "../utils/fetch-calls";
import { RECLAIM_SESSION_STATUS, MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../utils/constants";
import { generateProof, formatProof } from "../utils/proof-generator";
import { createClaimObject } from "../utils/claim-creator";
import { loggerService, LOG_TYPES } from "../utils/logger";
import { SessionTimerManager } from "../utils/session-timer";
import { debugLogger, DebugLogType } from "../utils/logger";
import { installOffscreenReadyListener } from "../utils/offscreen-manager";

import * as messageRouter from "./messageRouter";
import * as sessionManager from "./sessionManager";
import * as tabManager from "./tabManager";
import * as proofQueue from "./proofQueue";
import * as cookieUtils from "./cookieUtils";

export default function initBackground() {
  console.log("🚀 BACKGROUND INIT FUNCTION CALLED");

  installOffscreenReadyListener();

  // Context object to hold shared state and dependencies
  const ctx = {
    // State
    activeTabId: null,
    providerData: null,
    parameters: null,
    httpProviderId: null,
    appId: null,
    sessionId: null,
    callbackUrl: null,
    publicData: null,
    originalTabId: null,
    managedTabs: new Set(),
    generatedProofs: new Map(),
    filteredRequests: new Map(),
    proofGenerationQueue: [],
    isProcessingQueue: false,
    firstRequestReceived: false,
    initPopupMessage: new Map(),
    providerDataMessage: new Map(),
    activeSessionId: null,
    // Timer
    sessionTimerManager: new SessionTimerManager(),
    // Constants and dependencies
    fetchProviderData,
    updateSessionStatus,
    submitProofOnCallback,
    RECLAIM_SESSION_STATUS,
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    generateProof,
    formatProof,
    createClaimObject,
    loggerService,
    LOG_TYPES,
    debugLogger,
    DebugLogType,
    // Methods to be set below
    processFilteredRequest: null,
    failSession: null,
    submitProofs: null,
  };

  // Bind sessionManager methods to context
  ctx.failSession = (...args) => sessionManager.failSession(ctx, ...args);
  ctx.submitProofs = (...args) => sessionManager.submitProofs(ctx, ...args);

  // Add processFilteredRequest to context (move from class)
  ctx.processFilteredRequest = async function (request, criteria, sessionId, loginUrl) {
    try {
      if (!ctx.firstRequestReceived) {
        ctx.firstRequestReceived = true;
        ctx.sessionTimerManager.startSessionTimer();
      }

      ctx.loggerService.log({
        message: `Received filtered request ${request.url} from content script for request hash: ${criteria.requestHash}`,
        type: ctx.LOG_TYPES.BACKGROUND,
        sessionId: ctx.sessionId || "unknown",
        providerId: ctx.httpProviderId || "unknown",
        appId: ctx.appId || "unknown",
      });

      const cookies = await cookieUtils.getCookiesForUrl(
        request.url,
        ctx.debugLogger,
        ctx.DebugLogType,
      );
      if (cookies) {
        request.cookieStr = cookies;
      }

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_REQUESTED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { requestHash: criteria.requestHash },
      });

      let claimData = null;
      try {
        claimData = await ctx.createClaimObject(request, criteria, sessionId, loginUrl);
      } catch (error) {
        debugLogger.error(DebugLogType.BACKGROUND, "Error creating claim object:", error);
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { requestHash: criteria.requestHash },
        });
        ctx.failSession("Claim creation failed: " + error.message, criteria.requestHash);
        return { success: false, error: error.message };
      }

      console.log({ claimData });

      if (claimData) {
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_SUCCESS,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { requestHash: criteria.requestHash },
        });
        ctx.loggerService.log({
          message: `Claim Object creation successful for request hash: ${criteria.requestHash}`,
          type: ctx.LOG_TYPES.BACKGROUND,
          sessionId: ctx.sessionId || "unknown",
          providerId: ctx.httpProviderId || "unknown",
          appId: ctx.appId || "unknown",
        });
      }
      proofQueue.addToProofGenerationQueue(ctx, claimData, criteria.requestHash);
      return { success: true, message: "Proof generation queued" };
    } catch (error) {
      debugLogger.error(DebugLogType.BACKGROUND, "Error processing filtered request:", error);
      ctx.failSession("Error processing request: " + error.message, criteria.requestHash);
      return { success: false, error: error.message };
    }
  };

  // Set up session timer callbacks
  ctx.sessionTimerManager.setCallbacks(ctx.failSession);
  ctx.sessionTimerManager.setTimerDuration(30000);
  // Register message handler
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("background.js chrome.runtime.onMessage.addListener", {
      message,
      sender,
      sendResponse,
    });
    messageRouter.handleMessage(ctx, message, sender, sendResponse);
    return true; // Required for async response
  });

  // Listen for tab removals to clean up managedTabs
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (ctx.managedTabs.has(tabId)) {
      ctx.managedTabs.delete(tabId);
    }
  });
  console.log("🚀 BACKGROUND INITIALIZATION COMPLETE");
  return ctx;
}
