// Import polyfills
import "../utils/polyfills";

// Import necessary utilities and libraries
import {
  fetchProviderData,
  updateSessionStatus,
  submitProofOnCallback,
} from "../utils/fetch-calls";
import { RECLAIM_SESSION_STATUS, MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../utils/constants";
import { removeCspStrippingRule } from "./cspRuleManager";
import { generateProof, formatProof } from "../utils/proof-generator";
import { createClaimObject } from "../utils/claim-creator";
import { loggingHub } from "../utils/logger/LoggingHub";
import { SessionTimerManager } from "../utils/session-timer";
import { installOffscreenReadyListener } from "../utils/offscreen-manager";

import * as messageRouter from "./messageRouter";
import * as sessionManager from "./sessionManager";
import * as tabManager from "./tabManager";
import * as proofQueue from "./proofQueue";
import * as cookieUtils from "./cookieUtils";

export default function initBackground() {
  installOffscreenReadyListener();

  // Context object to hold shared state and dependencies
  const ctx = {
    // State
    activeTabId: null,
    providerData: null,
    parameters: {},
    context: null,
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
    _cspRuleId: null,
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
    // Logging hub
    loggingHub,
    // Methods to be set below
    processFilteredRequest: null,
    failSession: null,
    submitProofs: null,
  };

  // Clean up any orphaned CSP stripping rules from a previous session
  removeCspStrippingRule().catch(() => {});

  loggingHub.info("[BACKGROUND] Background initialized", "background.init");

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

      loggingHub.info(
        `[BACKGROUND] Filtering request for request hash: ${criteria.requestHash}`,
        "background.filter",
      );

      const cookies = await cookieUtils.getCookiesForUrl(request.url, loggingHub);
      if (cookies) {
        request.cookieStr = cookies;
      }

      loggingHub.debug(`[BACKGROUND] Cookies for URL: ${request.url}`, "background.cookies");

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_REQUESTED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { requestHash: criteria.requestHash },
      });

      loggingHub.info(
        "[BACKGROUND] Claim creation requested for request hash: " + criteria.requestHash,
        "background.claim",
      );

      let claimData = null;
      try {
        const criteriaWithGeo = {
          ...criteria,
          geoLocation: ctx.providerData?.geoLocation ?? "",
          extensionConfig: ctx.providerData?.extensionConfig,
        };
        claimData = await ctx.createClaimObject(
          request,
          criteriaWithGeo,
          sessionId,
          ctx.providerId,
          loginUrl,
          loggingHub,
          ctx.context,
        );
      } catch (error) {
        loggingHub.error(
          "[BACKGROUND] Error creating claim object: " + error.message,
          "background.claim",
        );
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
        loggingHub.info(
          "[BACKGROUND] Claim Object creation successful for request hash: " + criteria.requestHash,
          "background.claim",
        );
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
      loggingHub.info(
        "[BACKGROUND] Proof generation queued for request hash: " + criteria.requestHash,
        "background.proof",
      );
      return { success: true, message: "Proof generation queued" };
    } catch (error) {
      loggingHub.error(
        "[BACKGROUND] Error processing filtered request: " + error.message,
        "background.filter",
      );
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
        loggingHub.error("[BACKGROUND] Verification tab closed by user", "background.tab");
        await ctx.failSession("Verification tab closed by user");
      } catch {}
    }

    // Defensive: always clean up CSP rule when managed tab closes,
    // regardless of which path handled the session termination
    if ((lostActive || noManagedLeft) && ctx._cspRuleId) {
      removeCspStrippingRule().catch(() => {});
      ctx._cspRuleId = null;
    }

    if (lostActive) ctx.activeTabId = null;
    if (noManagedLeft) {
      ctx.originalTabId = null;
      ctx.activeSessionId = null; // clear stale guard
    }
  });

  loggingHub.info("[BACKGROUND] Background initialization complete", "background.init");
  return ctx;
}
