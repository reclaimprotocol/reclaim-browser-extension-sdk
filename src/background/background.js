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
import { BUILDER_EVENTS, createBuilderBridgeClient } from "../utils/builder";
import { loggingHub } from "../utils/logger/LoggingHub";
import { EVENT_TYPES } from "../utils/logger/constants";
import { SessionTimerManager } from "../utils/session-timer";
import { installOffscreenReadyListener } from "../utils/offscreen-manager";
import { claimProgress } from "../utils/claim-progress";

import * as messageRouter from "./messageRouter";
import * as sessionManager from "./sessionManager";

import * as tabManager from "./tabManager";
import * as proofQueue from "./proofQueue";
import * as cookieUtils from "./cookieUtils";

/**
 * Which link of the extraction chain failed -> how to report it.
 *
 * Spelled to match the InApp SDK's claim_creation.dart, which emits the same
 * four names at the same severities, so one query covers both SDKs. xPath and
 * jsonPath are errors — a selector that cannot find its element is almost always
 * a provider that upstream changed. A regex miss and an unsatisfied
 * responseMatch are warnings: on a page that is still loading they are the
 * normal intermediate state, and polling may well resolve them.
 */
const EXTRACTION_FAILURE_REPORTS = {
  xPath: { level: "error", eventType: EVENT_TYPES.X_PATH_MATCH_REQUIREMENT_FAILED },
  jsonPath: { level: "error", eventType: EVENT_TYPES.JSON_PATH_MATCH_REQUIREMENT_FAILED },
  regex: { level: "warn", eventType: EVENT_TYPES.REGEX_MATCH_REQUIREMENT_FAILED },
  responseMatch: { level: "warn", eventType: EVENT_TYPES.NO_RESPONSE_MATCH_WARNING },
};

/**
 * Say why the matched request did not yield a claim.
 *
 * Only ever reached for a request the content-script gate already matched, so
 * this is the "we found your request but could not read it" report, not
 * per-request noise.
 *
 * The response content the stage was looking at goes in the log PAYLOAD, never
 * in the message: the payload path gives the console the full value and the
 * endpoint a redacted, capped one. Interpolating it into the message published
 * the user's authenticated page content to the diagnostic endpoint.
 *
 * Repeats are demoted to debug. The content script re-polls every
 * NETWORK_FILTERING_INTERVAL_MS, so an unresolvable redaction is retried for the
 * lifetime of the session timer; without this, one stuck provider would emit the
 * same error ~30 times per session.
 *
 * @param {Object} ctx
 * @param {Error & {stage?: string, element?: string}} error
 * @param {Object} criteria - the matched requestData entry
 */
function reportExtractionFailure(ctx, error, criteria) {
  const stage = error?.stage || "redaction";
  const report = EXTRACTION_FAILURE_REPORTS[stage];

  const message =
    `[BACKGROUND] Matched request could not be extracted (${stage}) for request hash ` +
    `${criteria?.requestHash}, will retry on a later response: ${error.message}`;

  const key = `${criteria?.requestHash}|${stage}|${error.message}`;
  const firstTime = !ctx.reportedExtractionFailures.has(key);
  ctx.reportedExtractionFailures.add(key);

  if (!report) {
    // Unclassified: keep the pre-existing level and event so nothing regresses.
    loggingHub.info(message, "background.claim", { eventType: EVENT_TYPES.NO_PARAMETERS_FOUND });
    return;
  }

  const payload = error.element === undefined ? undefined : { element: error.element };
  loggingHub[firstTime ? report.level : "debug"](message, "background.claim", {
    eventType: report.eventType,
    payload,
  });
}

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
    // Extraction failures already reported this session, so a re-polled request
    // does not repeat the same error at full severity. See
    // reportExtractionFailure().
    reportedExtractionFailures: new Set(),
    proofGenerationQueue: [],
    isProcessingQueue: false,
    firstRequestReceived: false,
    initPopupMessage: new Map(),
    providerDataMessage: new Map(),
    activeSessionId: null,
    _cspRuleId: null,
    builder: null,
    isBuilderMode: false,
    isBuilderTransition: false,
    sessionTimerManager: new SessionTimerManager(),
    // Constants and dependencies
    fetchProviderData,
    updateSessionStatus,
    submitProofOnCallback,
    RECLAIM_SESSION_STATUS,
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    EVENT_TYPES,
    generateProof,
    formatProof,
    formatBuilderProof: (proof, requestData) => {
      const formatted = formatProof(proof, requestData);
      for (const [key, value] of Object.entries(proof || {})) {
        if (["claim", "signatures", "witnesses", "publicData"].includes(key)) continue;
        formatted[key] = value;
      }
      if (Array.isArray(proof?.witnesses)) formatted.witnesses = proof.witnesses;
      if (proof?.taskId != null) formatted.taskId = proof.taskId;
      return formatted;
    },
    createClaimObject,
    createBuilderBridgeClient,
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
  // Bound rather than imported: proofQueue is a set of free functions taking
  // ctx first and importing nothing from here, so this is how it reaches it.
  ctx.claimProgress = () => claimProgress(ctx);

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
        { eventType: EVENT_TYPES.REQUEST_MATCHED },
      );

      let topLevelUrl;
      try {
        const activeTab = await chrome.tabs.get(ctx.activeTabId);
        topLevelUrl = activeTab?.url;
      } catch (error) {
        loggingHub.info(
          "[BACKGROUND] Could not read active tab URL for cookie lookup: " + error?.message,
          "background.cookies",
        );
      }

      const cookies = await cookieUtils.getCookiesForUrl(request.url, loggingHub, topLevelUrl);
      if (cookies) {
        request.cookieStr = cookies;
      }

      // Real fetch/XHR calls always carry a browser-set Origin header that page JS
      // can neither read nor override, so the interceptor never captures it. Pass
      // the page's origin through so the claim can reconstruct it.
      if (topLevelUrl) {
        try {
          request.pageOrigin = new URL(topLevelUrl).origin;
        } catch (error) {
          loggingHub.info(
            "[BACKGROUND] Could not derive page origin from tab URL: " + error?.message,
            "background.claim",
          );
        }
      }

      loggingHub.debug(`[BACKGROUND] Cookies for URL: ${request.url}`, "background.cookies");

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_REQUESTED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        // progress is session-wide; the popup's own counters reset on every
        // navigation. See claimProgress().
        data: { requestHash: criteria.requestHash, progress: claimProgress(ctx) },
      });

      loggingHub.info(
        "[BACKGROUND] Claim creation requested for request hash: " + criteria.requestHash,
        "background.claim",
        { eventType: EVENT_TYPES.STARTING_CLAIM_CREATION },
      );

      if (ctx.builder) {
        await ctx.builder.client.reportEventBestEffort(
          ctx.builder.sessionId,
          BUILDER_EVENTS.REQUEST_MATCHED,
          builderRequestEventData(ctx, criteria),
        );
      }

      let claimData = null;
      try {
        const criteriaWithGeo = {
          ...criteria,
          geoLocation: ctx.providerData?.geoLocation ?? "",
          extensionConfig: ctx.providerData?.extensionConfig,
          templateParameters: ctx.parameters,
          ...(ctx.builder?.currentProvider?.attestorAuthRequest
            ? { attestorAuthRequest: ctx.builder.currentProvider.attestorAuthRequest }
            : {}),
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
        // A redaction that doesn't resolve against *this* response is not a
        // failure — the page usually just hasn't rendered the data yet. Report
        // it as retryable so the content script keeps polling, and leave the
        // session (and the popup) alone.
        //
        // This path exists because the authoritative xPath/jsonPath resolution
        // moved here from the content-script gate; before, a non-matching
        // response was simply never forwarded.
        if (error?.retryable) {
          reportExtractionFailure(ctx, error, criteria);
          return { success: false, retryable: true, error: error.message };
        }

        loggingHub.error(
          "[BACKGROUND] Error creating claim object: " + error.message,
          "background.claim",
          { eventType: EVENT_TYPES.CLAIM_PARAMETER_VALIDATION_FAILED_EXCEPTION },
        );
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.CLAIM_CREATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { requestHash: criteria.requestHash },
        });

        if (ctx.builder) {
          await ctx.builder.client.reportEventBestEffort(
            ctx.builder.sessionId,
            BUILDER_EVENTS.REQUEST_CLAIM_FAILED,
            {
              ...builderRequestEventData(ctx, criteria),
              attempt: 1,
              problem: {
                title: "Claim creation failed",
                reasonCode: "CLAIM_CREATION_FAILED",
                retryable: false,
              },
            },
          );
        }

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
          { eventType: EVENT_TYPES.CLAIM_CREATION_STARTED },
        );
        if (ctx.builder) {
          await ctx.builder.client.reportEventBestEffort(
            ctx.builder.sessionId,
            BUILDER_EVENTS.REQUEST_CLAIM_CREATED,
            { ...builderRequestEventData(ctx, criteria), attempt: 1 },
          );
        }
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
        { eventType: EVENT_TYPES.FILTER_REQUEST_ERROR },
      );
      ctx.failSession("Error processing request: " + error.message, criteria.requestHash);
      return { success: false, error: error.message };
    }
  };

  function builderRequestEventData(context, criteria) {
    const current = context.builder?.currentProvider;
    const requests = current?.providerData?.requestData || [];
    const requestOrdinal = requests.findIndex(
      (request) => request.requestHash === criteria?.requestHash,
    );
    const request = requestOrdinal >= 0 ? requests[requestOrdinal] : undefined;
    return {
      providerId: current?.recipe?.providerId,
      resolvedVersion: current?.recipe?.resolvedVersion,
      ordinal: context.builder?.providerOrdinal,
      ...(requestOrdinal >= 0 ? { requestOrdinal } : {}),
      ...(request?.builderRequestId ? { requestId: request.builderRequestId } : {}),
    };
  }

  // Set up session timer callbacks
  ctx.sessionTimerManager.setCallbacks((message, requestHash) =>
    ctx.failSession(message, requestHash, EVENT_TYPES.CLAIM_CREATION_TIMED_OUT_EXCEPTION),
  );
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
    if (
      ctx.activeSessionId &&
      (lostActive || noManagedLeft) &&
      !ctx.aborted &&
      !ctx.isBuilderTransition
    ) {
      ctx.aborted = true;
      try {
        loggingHub.error("[BACKGROUND] Verification tab closed by user", "background.tab", {
          eventType: EVENT_TYPES.RECLAIM_VERIFICATION_DISMISSED,
        });
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
