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
import { loggerService, createContextLogger } from "../utils/logger/LoggerService";
import { EVENT_TYPES, LOG_LEVEL, LOG_TYPES } from "../utils/logger/constants";
import { SessionTimerManager } from "../utils/session-timer";
import { debugLogger, DebugLogType } from "../utils/logger";
import { installOffscreenReadyListener } from "../utils/offscreen-manager";

import * as messageRouter from "./messageRouter";
import * as sessionManager from "./sessionManager";
import * as tabManager from "./tabManager";
import * as proofQueue from "./proofQueue";
import * as cookieUtils from "./cookieUtils";

const bgLogger = createContextLogger({
  sessionId: "unknown",
  providerId: "unknown",
  appId: "unknown",
  source: "reclaim-extension-sdk",
});

export default function initBackground() {
  installOffscreenReadyListener();

  // Context object to hold shared state and dependencies
  const ctx = {
    // State
    activeTabId: null,
    providerData: null,
    parameters: {},
    providerId: null,
    appId: null,
    sessionId: null,
    callbackUrl: null,
    publicData: null,
    aborted: false,
    expectManyClaims: false,
    originalTabId: null,
    managedTabs: new Set(),
    providerRequestsByHash: new Map(),
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
    bgLogger,
    debugLogger,
    DebugLogType,
    // Methods to be set below
    processFilteredRequest: null,
    failSession: null,
    submitProofs: null,
  };

  bgLogger.setContext({
    sessionId: ctx.sessionId || "unknown",
    providerId: ctx.providerId || "unknown",
    appId: ctx.appId || "unknown",
    type: LOG_TYPES.BACKGROUND,
  });

  bgLogger.info({
    message: "Background initialized INFO",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.BACKGROUND,
  });

  // Bind sessionManager methods to context
  ctx.failSession = (...args) => sessionManager.failSession(ctx, ...args);
  ctx.submitProofs = (...args) => sessionManager.submitProofs(ctx, ...args);

  // Add processFilteredRequest to context (move from class)
  ctx.processFilteredRequest = async function (request, criteria, sessionId, loginUrl) {
    try {
      sessionId = ctx.sessionId || sessionId;
      if (!sessionId) {
        ctx.failSession("Session not initialized for claim request", criteria?.requestHash);
        return { success: false, error: "Session not initialized" };
      }
      if (!ctx.firstRequestReceived) {
        ctx.firstRequestReceived = true;
        ctx.sessionTimerManager.startSessionTimer();
      }

      bgLogger.setContext({
        sessionId: ctx.sessionId || "unknown",
        providerId: ctx.providerId || "unknown",
        appId: ctx.appId || "unknown",
        type: LOG_TYPES.BACKGROUND,
      });
      bgLogger.info({
        message: `[BACKGROUND] Filtering request for request hash: ${criteria.requestHash}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });

      const cookies = await cookieUtils.getCookiesForUrl(request.url, ctx.bgLogger);
      if (cookies) {
        request.cookieStr = cookies;
      }

      bgLogger.log({
        message: `[BACKGROUND] Cookies for URL: ${request.url}`,
        logLevel: LOG_LEVEL.ALL,
        type: LOG_TYPES.BACKGROUND,
        meta: {
          request: request,
          criteria: criteria,
          sessionId: sessionId,
          loginUrl: loginUrl,
          cookies: cookies,
        },
      });

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_REQUESTED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { requestHash: criteria.requestHash },
      });

      bgLogger.info({
        message: "[BACKGROUND] Claim creation requested for request hash: " + criteria.requestHash,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
        eventType: EVENT_TYPES.STARTING_CLAIM_CREATION,
      });

      let claimData = null;
      try {
        const criteriaWithGeo = { ...criteria, geoLocation: ctx.providerData?.geoLocation ?? "" };
        claimData = await ctx.createClaimObject(
          request,
          criteriaWithGeo,
          sessionId,
          ctx.providerId,
          loginUrl,
          ctx.bgLogger,
        );
      } catch (error) {
        bgLogger.error({
          message: "[BACKGROUND] Error creating claim object: " + error.message,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { requestHash: criteria.requestHash },
        });

        ctx.failSession("Claim creation failed: " + error.message, criteria.requestHash);
        return { success: false, error: error.message };
      }

      if (claimData) {
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_SUCCESS,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { requestHash: criteria.requestHash },
        });
        bgLogger.info({
          message:
            "[BACKGROUND] Claim Object creation successful for request hash: " +
            criteria.requestHash,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
      const providerRequest = {
        url: criteria?.url || request?.url || "",
        expectedPageUrl: criteria?.expectedPageUrl || "",
        urlType: criteria?.urlType || "EXACT",
        method: criteria?.method || request?.method || "GET",
        responseMatches: Array.isArray(criteria?.responseMatches) ? criteria.responseMatches : [],
        responseRedactions: Array.isArray(criteria?.responseRedactions)
          ? criteria.responseRedactions
          : [],
        requestHash: criteria?.requestHash,
      };
      if (providerRequest.requestHash) {
        ctx.providerRequestsByHash.set(providerRequest.requestHash, providerRequest);
      }
      proofQueue.addToProofGenerationQueue(ctx, claimData, criteria.requestHash);
      bgLogger.info({
        message: "[BACKGROUND] Proof generation queued for request hash: " + criteria.requestHash,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
      return { success: true, message: "Proof generation queued" };
    } catch (error) {
      bgLogger.error({
        message: "[BACKGROUND] Error processing filtered request: " + error.message,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
      ctx.failSession("Error processing request: " + error.message, criteria.requestHash);
      return { success: false, error: error.message };
    }
  };

  // Set up session timer callbacks
  ctx.sessionTimerManager.setCallbacks(ctx.failSession);
  ctx.sessionTimerManager.setTimerDuration(30000);
  // Register message handler
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    messageRouter.handleMessage(ctx, message, sender, sendResponse);
    return true; // Required for async response
  });

  // Listen for tab removals to clean up managedTabs
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const wasManaged = ctx.managedTabs.has(tabId);
    if (wasManaged) ctx.managedTabs.delete(tabId);

    const lostActive = tabId === ctx.activeTabId;
    const noManagedLeft = ctx.managedTabs.size === 0;

    // If there is an active session and we lost its tab(s), fail immediately.
    if (ctx.activeSessionId && (lostActive || noManagedLeft) && !ctx.aborted) {
      ctx.aborted = true;
      try {
        bgLogger.error({
          message: "[BACKGROUND] Verification tab closed by user",
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
          sessionId: ctx.activeSessionId || ctx.sessionId || "unknown",
          providerId: ctx.providerId || "unknown",
          appId: ctx.appId || "unknown",
          eventType: EVENT_TYPES.RECLAIM_VERIFICATION_DISMISSED,
        });
        await ctx.failSession("Verification tab closed by user");
      } catch {}
    }

    if (lostActive) ctx.activeTabId = null;
    if (noManagedLeft) {
      ctx.originalTabId = null;
      ctx.activeSessionId = null; // clear stale guard
    }
  });

  bgLogger.info({
    message: "[BACKGROUND] 🚀 Background initialization complete",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.BACKGROUND,
  });
  return ctx;
}
