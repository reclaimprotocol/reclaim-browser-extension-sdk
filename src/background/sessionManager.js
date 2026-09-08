// Session management for background script
// Handles session start, fail, submit, and timer logic

import { loggingHub } from "../utils/logger/LoggingHub";
import { EVENT_TYPES } from "../utils/logger/constants";
import { normalizeInjectionType } from "../utils/provider-normalization";
import { addCspStrippingRule, removeCspStrippingRule } from "./cspRuleManager";
import { CSP_RULE_MAX_LIFETIME_MS, TAB_TRANSITION_DELAY_MS } from "../utils/constants/config";
import {
  BUILDER_EVENTS,
  builderProblem,
  builderProviderParameters,
  builderRecipeToProviderData,
  normalizeVerificationClientId,
} from "../utils/builder";
import { getClientSource } from "../utils/logger/client-source";
import { clearBuilderCspRule } from "./builder-transition";

const BUILDER_CLAIMANT_ID_STORAGE_KEY = "reclaim_builder_claimant_client_id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function startVerification(ctx, templateData) {
  try {
    // A CSP timer belongs to exactly one provider/session. Invalidate the
    // previous timer before Builder preparation can await network calls.
    invalidateCspRuleTimer(ctx);
    const isBuilderRequest = templateData?.builder?.apiVersion === "2";
    // A later legacy request must not inherit a failed Builder request's mode.
    // During a Builder multi-provider transition `ctx.builder` remains set,
    // so preserve the established Builder state for the internally-started next provider.
    if (!ctx.builder) ctx.isBuilderMode = isBuilderRequest;
    if (isBuilderRequest) {
      templateData = await prepareBuilderProvider(ctx, templateData);
    }

    // clear all the member variables
    ctx.providerData = null;
    ctx.parameters = {};
    ctx.context = null;
    ctx.providerId = null;
    ctx.appId = null;
    ctx.sessionId = null;
    ctx.callbackUrl = null;
    ctx.generatedProofs = new Map();
    ctx.filteredRequests = new Map();
    ctx.reportedExtractionFailures = new Set();
    ctx.initPopupMessage = new Map();
    ctx.providerDataMessage = new Map();
    ctx.providerRequestsByHash = new Map();
    ctx.aborted = false;
    ctx.expectManyClaims = false;
    ctx._cspRuleId = null;

    ctx.sessionTimerManager.clearAllTimers();
    ctx.firstRequestReceived = false;

    if (!templateData.providerId) {
      throw new Error("Provider ID not found");
    }

    ctx.loggingHub.setSessionContext({
      sessionId: templateData.sessionId,
      providerId: templateData.providerId,
      appId: templateData.applicationId,
    });

    // fetch provider data from the backend
    loggingHub.info(
      `[BACKGROUND] Fetching provider data from the backend for provider Id ${templateData.providerId}`,
      "background.provider",
    );

    const providerData = ctx.builder?.currentProvider?.providerData
      ? ctx.builder.currentProvider.providerData
      : await ctx.fetchProviderData(
          templateData.providerId,
          templateData.sessionId,
          templateData.applicationId,
        );

    // Coerce injectionType before anything reads it. The router hands it to
    // the content script, which only distinguishes NONE from "inject the
    // interceptor" — an unsupported value (MSWJS/XHOOK/CDP) would otherwise
    // flow through unchecked.
    if (providerData) {
      providerData.injectionType = normalizeInjectionType(providerData.injectionType, loggingHub);
    }
    ctx.providerData = providerData;

    loggingHub.info(
      `[BACKGROUND] Fetched provider data for ${templateData.providerId}: ` +
        `${providerData?.name || "unnamed"}, ${providerData?.requestData?.length ?? 0} request(s)`,
      "background.provider",
      { eventType: EVENT_TYPES.FETCHED_PROVIDERS },
    );

    ctx.providerId = templateData.providerId;
    if (templateData.parameters) {
      ctx.parameters = templateData.parameters;
    }

    // Store user-supplied context (contextAddress & contextMessage) for claim creation
    if (templateData.context) {
      try {
        ctx.context =
          typeof templateData.context === "string"
            ? JSON.parse(templateData.context)
            : templateData.context;
      } catch {
        ctx.context = null;
      }
    }

    // callbackUrl optional
    if (typeof templateData.callbackUrl === "string") {
      ctx.callbackUrl = templateData.callbackUrl;
    }

    if (templateData.sessionId) {
      ctx.sessionId = templateData.sessionId;
    }

    if (templateData.applicationId) {
      ctx.appId = templateData.applicationId;
    }

    if (!providerData) {
      throw new Error("Provider data not found");
    }

    // Strip CSP headers for the provider page if custom injection is needed
    if (providerData?.extensionConfig?.allowInjectionsViaChromeScripting) {
      try {
        const { ruleId } = await addCspStrippingRule(providerData.loginUrl);
        ctx._cspRuleId = ruleId;
        // Safety net: auto-remove after max lifetime regardless of cleanup paths.
        // Guard by generation so an old provider cannot remove a newer rule.
        const generation = ctx._cspRuleGeneration;
        ctx._cspRuleTimer = setTimeout(() => {
          if (ctx._cspRuleGeneration === generation && ctx._cspRuleId) {
            removeCspStrippingRule().catch(() => {});
            ctx._cspRuleId = null;
            ctx._cspRuleTimer = null;
            loggingHub.info(
              "[BACKGROUND] CSP rule auto-removed after max lifetime",
              "background.csp",
            );
          }
        }, CSP_RULE_MAX_LIFETIME_MS);
      } catch (e) {
        loggingHub.error(
          `[BACKGROUND] Failed to add CSP stripping rule: ${e?.message}`,
          "background.csp",
        );
        // Non-fatal: injection may still work on permissive sites
      }
    }

    // Create a new tab with provider URL DIRECTLY - not through an async flow
    const providerUrl = providerData.loginUrl;

    if (ctx.builder) {
      await ctx.builder.client.reportEventBestEffort(
        ctx.builder.sessionId,
        BUILDER_EVENTS.VERIFICATION_BROWSER_STARTED,
        {
          providerId: ctx.builder.currentProvider.recipe.providerId,
          resolvedVersion: ctx.builder.currentProvider.recipe.resolvedVersion,
          ordinal: ctx.builder.providerOrdinal,
        },
      );
    }

    // Use chrome.tabs.create directly and handle the promise explicitly
    chrome.tabs.create({ url: providerUrl }, (tab) => {
      ctx.activeTabId = tab.id;
      loggingHub.info(
        `[BACKGROUND] New tab created for provider ${templateData.providerId} with tab id ${tab.id}`,
        "background.tab",
        { eventType: EVENT_TYPES.LOADING_INITIAL_URL },
      );

      ctx.managedTabs.add(tab.id);

      const providerName = ctx.providerData?.name || "Default Provider";
      const description = ctx.providerData?.description || "Default Description";
      const dataRequired = ctx.providerData?.verificationConfig?.dataRequired || "Default Data";
      const sessionId = ctx.sessionId || "unknown";

      if (tab.id) {
        const popupMessage = {
          action: ctx.MESSAGE_ACTIONS.SHOW_PROVIDER_VERIFICATION_POPUP,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: {
            providerName,
            description,
            dataRequired,
            sessionId,
          },
        };

        const providerDataMessage = {
          action: ctx.MESSAGE_ACTIONS.PROVIDER_DATA_READY,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: {
            providerData: ctx.providerData,
            parameters: ctx.parameters,
            sessionId: ctx.sessionId,
            callbackUrl: ctx.callbackUrl,
            providerId: ctx.providerId,
            appId: ctx.appId,
            builder: ctx.builder?.sessionMetadata,
          },
        };

        if (!ctx.initPopupMessage) {
          ctx.initPopupMessage = new Map();
        }

        // Store the message in the init PopupMessage for the tab
        ctx.initPopupMessage.set(tab.id, { message: popupMessage });

        // Store the provider data in the providerDataMap for the tab
        ctx.providerDataMessage.set(tab.id, { message: providerDataMessage });
      } else {
        loggingHub.error(
          `[BACKGROUND] New tab does not have an ID, cannot queue message for popup.`,
          "background.tab",
        );
      }

      loggingHub.info(
        `[BACKGROUND] Starting verification with session id: ${ctx.sessionId}`,
        "background.verification",
        { eventType: EVENT_TYPES.USER_STARTED_VERIFICATION },
      );

      // Update session status after tab creation
      if (!ctx.builder) {
        ctx
          .updateSessionStatus(
            templateData.sessionId,
            ctx.RECLAIM_SESSION_STATUS.USER_STARTED_VERIFICATION,
            templateData.providerId,
            templateData.applicationId,
          )
          .catch((error) => {
            loggingHub.error(
              `[BACKGROUND] Error updating session status: ${error?.message}`,
              "background.session",
              { eventType: EVENT_TYPES.UPDATE_SESSION_STATUS_ERROR },
            );
          });
      }
    });

    return {
      success: true,
      message: "Verification started, redirecting to provider login page",
    };
  } catch (error) {
    loggingHub.error(
      `[BACKGROUND] Error starting verification: ${error?.message}`,
      "background.verification",
      { eventType: EVENT_TYPES.RECLAIM_EXCEPTION },
    );
    // Clean up CSP stripping rule if it was added before the error
    if (ctx._cspRuleId) {
      await removeCspStrippingRule().catch(() => {});
      ctx._cspRuleId = null;
    }
    invalidateCspRuleTimer(ctx);
    // Release concurrency guard on immediate failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function failSession(ctx, errorMessage, requestHash, eventType) {
  loggingHub.info(`[BACKGROUND] Failing session: ${errorMessage}`, "background.session", {
    eventType: eventType || EVENT_TYPES.RECLAIM_EXCEPTION,
  });

  if (ctx._cspRuleId) {
    await removeCspStrippingRule().catch(() => {});
    ctx._cspRuleId = null;
  }
  invalidateCspRuleTimer(ctx);

  ctx.sessionTimerManager.clearAllTimers();

  // abort immediately to stop queue/offscreen processing
  ctx.aborted = true;

  // A successfully submitted or cancelled Builder terminal owns the outcome.
  // An error reservation is deliberately not a guard: its signed submission
  // may have failed, and the local failure path still must clean up.
  if (ctx.builder?.terminal === "success" || ctx.builder?.terminal === "cancelled") return;

  // Builder reports terminal state through its direct API. Legacy sessions
  // retain their existing status update behaviour.
  if (ctx.builder) {
    await submitBuilderFailure(ctx, "PROOF_ENGINE_ERROR", "Proof generation failed");
  } else if (!ctx.isBuilderMode && ctx.sessionId) {
    try {
      await ctx.updateSessionStatus(
        ctx.sessionId,
        ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
        ctx.providerId,
        ctx.appId,
      );

      loggingHub.info(
        `[BACKGROUND] Updated session status to failed: ${ctx.sessionId}`,
        "background.session",
      );
    } catch (error) {
      loggingHub.error(
        `[BACKGROUND] Error updating session status to failed: ${error?.message}`,
        "background.session",
        { eventType: EVENT_TYPES.UPDATE_SESSION_STATUS_ERROR },
      );
    }
  }

  // Notify content script about failure (active tab)
  if (ctx.activeTabId) {
    chrome.tabs
      .sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { requestHash: requestHash, sessionId: ctx.sessionId },
      })
      .catch((err) => {
        loggingHub.error(
          `[BACKGROUND] Error notifying content script of session failure: ${err?.message}`,
          "background.session",
        );
      });
  }

  if (ctx.originalTabId) {
    try {
      await chrome.tabs.sendMessage(ctx.originalTabId, {
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { error: errorMessage, sessionId: ctx.sessionId },
      });
    } catch (e) {
      loggingHub.error(
        `[BACKGROUND] Error notifying original tab of session failure: ${e?.message}`,
        "background.session",
      );
    }
  }

  // Broadcast to popup/options pages
  try {
    loggingHub.info(
      `[BACKGROUND] Proof generation failed, Broadcasting to popup/options pages: ${errorMessage}`,
      "background.proof",
      { eventType: EVENT_TYPES.PROOF_GENERATION_FAILED },
    );

    await chrome.runtime.sendMessage({
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
      data: { error: errorMessage, sessionId: ctx.sessionId },
    });
  } catch (e) {
    loggingHub.error(
      `[BACKGROUND] Error broadcasting to popup/options pages: ${e?.message}`,
      "background.session",
    );
  }

  // Clear the queue
  ctx.proofGenerationQueue = [];
  ctx.isProcessingQueue = false;

  await ctx.loggingHub.clearSessionContext();

  // Release concurrency guard
  ctx.activeSessionId = null;
  ctx.builder = null;
  ctx.isBuilderMode = false;
}

export async function submitProofs(ctx) {
  try {
    // Hold if user set canExpectManyClaims(true)
    if (ctx.expectManyClaims) return;

    ctx.sessionTimerManager.clearAllTimers();

    if (ctx.generatedProofs.size === 0) return;

    const hasTemplateList =
      Array.isArray(ctx.providerData?.requestData) && ctx.providerData.requestData.length > 0;

    if (hasTemplateList) {
      const completedTemplate = ctx.providerData.requestData.filter((rd) =>
        ctx.generatedProofs.has(rd.requestHash),
      ).length;
      if (completedTemplate !== ctx.providerData.requestData.length) return;
    }

    const formattedProofs = [];
    const templateHashes = new Set();

    if (hasTemplateList) {
      for (const rd of ctx.providerData.requestData) {
        if (ctx.generatedProofs.has(rd.requestHash)) {
          const proof = ctx.generatedProofs.get(rd.requestHash);
          formattedProofs.push(
            ctx.builder ? ctx.formatBuilderProof(proof, rd) : ctx.formatProof(proof, rd),
          );
          templateHashes.add(rd.requestHash);
        }
      }
    }

    for (const [hash, proof] of ctx.generatedProofs.entries()) {
      if (templateHashes.has(hash)) continue;
      const providerRequest = ctx.providerRequestsByHash.get(hash) || {
        url: "",
        expectedPageUrl: "",
        urlType: "EXACT",
        method: "GET",
        responseMatches: [],
        responseRedactions: [],
        requestHash: hash,
      };
      formattedProofs.push(
        ctx.builder
          ? ctx.formatBuilderProof(proof, providerRequest)
          : ctx.formatProof(proof, providerRequest),
      );
    }

    const finalProofs = formattedProofs.map((fp) => ({
      ...fp,
      publicData: ctx.publicData ?? null,
    }));

    // At INFO the identifier, signatures, witnesses and providerRequest survive
    // redaction while `claimData` is blanked wholesale — the same shape the
    // InApp SDK's own PROOF_GENERATED line has. That is deliberate: `claimData`
    // holds `context.extractedParameters`, which is the plaintext value the user
    // is proving, and this used to reach Loki on every successful session.
    loggingHub.info("[BACKGROUND] Submitting proofs", "background.proof", {
      eventType: EVENT_TYPES.SUBMITTING_PROOF,
      payload: finalProofs,
    });

    let submitted = false;
    if (ctx.builder) {
      await completeBuilderProvider(ctx, finalProofs);
      return { success: true };
    }

    // If callbackUrl provided, submit; otherwise just signal completion
    if (ctx.callbackUrl && typeof ctx.callbackUrl === "string" && ctx.callbackUrl.length > 0) {
      try {
        loggingHub.info(
          `[BACKGROUND] Submitting proofs to callback URL: ${ctx.callbackUrl}`,
          "background.proof",
        );
        await ctx.submitProofOnCallback(
          finalProofs,
          ctx.callbackUrl,
          ctx.sessionId,
          ctx.providerId,
          ctx.appId,
        );
        submitted = true;
      } catch (error) {
        // Notify original tab
        try {
          loggingHub.error(
            `[BACKGROUND] Notifying original tab of proof submission failure: ${error.message}`,
            "background.proof",
          );
          await chrome.tabs.sendMessage(ctx.originalTabId, {
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            source: ctx.MESSAGE_SOURCES.BACKGROUND,
            target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {
          loggingHub.error(
            `[BACKGROUND] Error notifying original tab of proof submission failure: ${e?.message}`,
            "background.proof",
          );
        }

        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: error.message, sessionId: ctx.sessionId },
        });

        loggingHub.error(
          `[BACKGROUND] Broadcasting to runtime of proof submission failure: ${error.message}`,
          "background.proof",
        );
        // Broadcast to runtime
        try {
          await chrome.runtime.sendMessage({
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {}

        loggingHub.error(
          `[BACKGROUND] Error submitting proofs: ${error.message}`,
          "background.proof",
          { eventType: EVENT_TYPES.PROOF_SUBMISSION_FAILED },
        );
        throw error;
      }
    } else {
      // No callback: set status to generation success
      if (ctx.sessionId) {
        try {
          loggingHub.info(
            `[BACKGROUND] Updating status to PROOF_GENERATION_SUCCESS`,
            "background.proof",
            { eventType: EVENT_TYPES.PROOF_GENERATION_SUCCESS },
          );
          await ctx.updateSessionStatus(
            ctx.sessionId,
            ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS,
            ctx.providerId,
            ctx.appId,
          );
        } catch (e) {
          loggingHub.error(
            `[BACKGROUND] Error updating status to PROOF_GENERATION_SUCCESS: ${e?.message}`,
            "background.session",
          );
        }
      }
    }

    // Emitted once, before the notifications and independently of them. It used
    // to ride on the activeTabId branch below, so a flow that completed after
    // the provider tab had closed produced no PROOF_SUBMITTED event at all —
    // the session simply stopped mid-stream in the logs. `submitted` is spelled
    // out because with no callbackUrl nothing is posted anywhere: the proofs are
    // handed back to the consumer, which the event name alone does not convey.
    loggingHub.info(
      `[BACKGROUND] Proofs ready (${finalProofs.length}), submittedToCallback=${submitted}`,
      "background.proof",
      { eventType: EVENT_TYPES.PROOF_SUBMITTED },
    );

    // Notify content script with proofs in both cases
    if (ctx.activeTabId) {
      try {
        loggingHub.info(
          `[BACKGROUND] Proof submitted, Notifying content script with proofs`,
          "background.proof",
        );
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (error) {
        loggingHub.error(
          `[BACKGROUND] Error notifying content script: ${error?.message}`,
          "background.proof",
        );
      }
    }

    if (ctx.originalTabId) {
      try {
        loggingHub.info(
          `[BACKGROUND] Proof submitted, Notifying original tab with proofs`,
          "background.proof",
        );

        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (e) {
        loggingHub.error(
          `[BACKGROUND] Error notifying original tab: ${e?.message}`,
          "background.proof",
        );
      }
    }

    // Broadcast to runtime (popup/options)
    try {
      loggingHub.info(`[BACKGROUND] Proof submitted, Broadcasting to runtime`, "background.proof");
      await chrome.runtime.sendMessage({
        action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
        data: { formattedProofs, submitted, sessionId: ctx.sessionId },
      });
    } catch (e) {}

    if (ctx.originalTabId) {
      try {
        setTimeout(async () => {
          await chrome.tabs.update(ctx.originalTabId, { active: true });
          if (ctx.activeTabId) {
            await chrome.tabs.remove(ctx.activeTabId);
            ctx.activeTabId = null;
          }
          ctx.originalTabId = null;
        }, TAB_TRANSITION_DELAY_MS);
      } catch (error) {
        loggingHub.error(
          `[BACKGROUND] Error navigating back or closing tab: ${error?.message}`,
          "background.tab",
        );
      }
    } else if (ctx.activeTabId) {
      // Fallback: started from panel/popup, no original tab to return to
      try {
        setTimeout(async () => {
          await chrome.tabs.remove(ctx.activeTabId);
          ctx.activeTabId = null;
        }, TAB_TRANSITION_DELAY_MS);
      } catch (e) {
        /* ignore */
      }
    }

    if (ctx._cspRuleId) {
      await removeCspStrippingRule().catch(() => {});
      ctx._cspRuleId = null;
    }
    invalidateCspRuleTimer(ctx);

    await ctx.loggingHub.clearSessionContext();

    // Release concurrency guard on success
    ctx.activeSessionId = null;
    return { success: true };
  } catch (error) {
    loggingHub.error(`[BACKGROUND] Error submitting proof: ${error?.message}`, "background.proof");
    if (ctx._cspRuleId) {
      await removeCspStrippingRule().catch(() => {});
      ctx._cspRuleId = null;
    }
    invalidateCspRuleTimer(ctx);
    // Release concurrency guard on failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function cancelSession(ctx, requestedSessionId) {
  try {
    if (!ctx.sessionId || String(ctx.sessionId) !== String(requestedSessionId ?? "")) {
      return false;
    }
    loggingHub.info(`[BACKGROUND] Cancelling session`, "background.session", {
      eventType: EVENT_TYPES.RECLAIM_VERIFICATION_CANCELLED_EXCEPTION,
    });

    if (ctx._cspRuleId) {
      await removeCspStrippingRule().catch(() => {});
      ctx._cspRuleId = null;
    }
    invalidateCspRuleTimer(ctx);

    ctx.sessionTimerManager.clearAllTimers();

    // abort immediately to stop queue/offscreen processing
    ctx.aborted = true;

    // Builder reports cancellation through its direct API. Legacy sessions keep
    // their status update because its protocol has no cancellation state.
    if (ctx.builder) {
      if (!claimBuilderTerminal(ctx.builder, "cancelled")) return false;
      await ctx.builder.client.reportEventBestEffort(
        ctx.sessionId,
        BUILDER_EVENTS.VERIFICATION_CANCELLED,
        {
          initiator: "USER",
          cancellationReason: "USER_CANCELLED",
        },
      );
      await submitBuilderTerminal(
        ctx,
        "cancelled",
        "VERIFICATION_CANCELLED",
        "Verification cancelled",
        false,
      );
    } else if (!ctx.isBuilderMode && ctx.sessionId) {
      try {
        loggingHub.info(
          `[BACKGROUND] Proof generation failed, Updating status on cancel`,
          "background.session",
        );
        await ctx.updateSessionStatus(
          ctx.sessionId,
          ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
          ctx.providerId,
          ctx.appId,
        );
      } catch (error) {
        loggingHub.error(
          `[BACKGROUND] Error updating status on cancel: ${error?.message}`,
          "background.session",
        );
      }
    }

    // Notify content about failure with error message 'Cancelled by user'
    if (ctx.activeTabId) {
      try {
        loggingHub.info(
          `[BACKGROUND] Proof generation failed, Notifying content on cancel`,
          "background.session",
        );
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        loggingHub.error(
          `[BACKGROUND] Error notifying content on cancel: ${e?.message}`,
          "background.session",
        );
      }
    }

    if (ctx.originalTabId) {
      try {
        loggingHub.info(
          `[BACKGROUND] Proof generation failed, Notifying original tab on cancel`,
          "background.session",
        );
        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        /* ignore */
        loggingHub.error(
          `[BACKGROUND] Error notifying original tab on cancel: ${e?.message}`,
          "background.session",
        );
      }
    }

    // Broadcast to runtime
    try {
      loggingHub.info(
        `[BACKGROUND] Proof generation failed, Broadcasting to runtime on cancel`,
        "background.session",
      );
      await chrome.runtime.sendMessage({
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
        data: { error: "Cancelled by user", sessionId: ctx.sessionId },
      });
    } catch (e) {
      loggingHub.error(
        `[BACKGROUND] Error broadcasting to runtime on cancel: ${e?.message}`,
        "background.session",
      );
    }

    if (ctx.originalTabId) {
      try {
        setTimeout(async () => {
          await chrome.tabs.update(ctx.originalTabId, { active: true });
          if (ctx.activeTabId) {
            await chrome.tabs.remove(ctx.activeTabId);
            ctx.activeTabId = null;
          }
          ctx.originalTabId = null;
        }, 200);
      } catch (error) {
        loggingHub.error(
          `[BACKGROUND] Error closing tab on cancel: ${error?.message}`,
          "background.tab",
        );
      }
    } else if (ctx.activeTabId) {
      try {
        await chrome.tabs.remove(ctx.activeTabId);
        ctx.activeTabId = null;
      } catch (e) {
        loggingHub.error(
          `[BACKGROUND] Error closing active tab on cancel: ${e?.message}`,
          "background.tab",
        );
      }
    }

    // Clear queues and session data
    ctx.proofGenerationQueue = [];
    ctx.isProcessingQueue = false;
    ctx.providerData = null;
    ctx.parameters = {};
    ctx.context = null;
    ctx.providerId = null;
    ctx.appId = null;
    ctx.sessionId = null;
    ctx.callbackUrl = null;
    ctx.providerRequestsByHash = new Map();
    ctx.managedTabs.clear();
    ctx.builder = null;
    ctx.isBuilderMode = false;

    await ctx.loggingHub.clearSessionContext();

    // Release guard
    ctx.activeSessionId = null;
    return true;
  } catch (e) {
    ctx.activeSessionId = null;
    loggingHub.error(
      `[BACKGROUND] Error during cancelSession: ${e?.message}`,
      "background.session",
    );
    return false;
  }
}

async function prepareBuilderProvider(ctx, templateData) {
  const config = templateData.builder;
  if (!ctx.builder) {
    ctx.loggingHub.setConfig({ logLevel: config.diagnosticMode ? "DEBUG" : "INFO" });
    const claimantClientId = await resolveClaimantClientId(config.claimantClientId);
    const verificationClientId = normalizeVerificationClientId(config.verificationClientId);
    const client = ctx.createBuilderBridgeClient({
      backendUrl: config.backendUrl,
      verificationClientId: config.verificationClientId,
    });
    const bootstrap = await client.bootstrap(config.sessionId);
    assertBuilderBootstrap(bootstrap, config.sessionId);
    if (
      bootstrap.session.verificationClientId &&
      normalizeVerificationClientId(bootstrap.session.verificationClientId) !== verificationClientId
    ) {
      throw new Error("Builder session Verification Client does not match the request");
    }

    ctx.builder = {
      client,
      sessionId: config.sessionId,
      session: bootstrap.session,
      recipes: bootstrap.recipes,
      results: [],
      proofs: [],
      providerOrdinal: 0,
      claimantClientId,
      verificationClientId,
      claimantDetails: config.claimantDetails || {},
      parameters:
        templateData.parameters &&
        typeof templateData.parameters === "object" &&
        !Array.isArray(templateData.parameters)
          ? { ...templateData.parameters }
          : {},
      diagnosticMode: config.diagnosticMode === true,
      terminal: false,
      sessionMetadata: {
        theme: bootstrap.session.theme ?? null,
        preferredLocale:
          bootstrap.session.preferredLocale ?? bootstrap.session.theme?.preferredLocale ?? null,
        consent: bootstrap.session.theme?.consent ?? bootstrap.session.consent ?? null,
        runtimeConfig: bootstrap.session.runtimeConfig ?? null,
      },
    };

    // The extension popup has no consent renderer. Never silently proceed
    // without the consent step configured by Builder; submit a signed error
    // through the normal start-failure path instead. Theme, locale and runtime
    // flags are retained as metadata for consumers while the existing popup
    // safely falls back to its legacy presentation.
    if (hasBuilderConsent(ctx.builder.sessionMetadata.consent)) {
      throw new Error("Builder consent is configured but the extension cannot render consent UI");
    }

    await client.reportEventBestEffort(
      config.sessionId,
      BUILDER_EVENTS.VERIFICATION_CLIENT_OPENED,
      {
        claimantClientId,
      },
    );
    if (config.diagnosticMode) {
      await client.reportEventBestEffort(
        config.sessionId,
        BUILDER_EVENTS.VERIFICATION_DIAGNOSTICS_MODE_CHANGED,
        {
          previousMode: "STANDARD",
          mode: "SENSITIVE",
          sensitiveDataLevel: "PERSONAL_DATA",
          scopes: ["ATTESTOR_LOGS", "STACKTRACES"],
          authorizationReason: "CLIENT_DEBUGGING",
          source: "launch_url",
        },
      );
    }
    try {
      const observedDetails = await collectBrowserClaimantDetails();
      await client.patchClaimant(config.sessionId, {
        claimantId: claimantClientId,
        collectedAt: new Date().toISOString(),
        apiClient: getClientSource(),
        locale: globalThis.navigator?.language,
        httpUserAgent: globalThis.navigator?.userAgent,
        client: {
          kind: "reclaim_browser_extension_sdk",
          verificationClient: {
            id: builder.verificationClientId,
            name: "reclaim_browser_extension_sdk",
          },
          application: {
            packageName: globalThis.chrome?.runtime?.id,
            version: globalThis.chrome?.runtime?.getManifest?.()?.version,
          },
        },
        device: { id: claimantClientId, ...observedDetails.device },
        operatingSystem: { platform: globalThis.navigator?.platform },
        browser: {
          userAgent: globalThis.navigator?.userAgent,
          ...observedDetails.browser,
        },
        ...observedDetails.dimensions,
        ...config.claimantDetails,
        claimantClientId,
      });
    } catch {
      // Claimant diagnostics are optional and must not block verification.
    }
    await client.reportEventBestEffort(config.sessionId, BUILDER_EVENTS.VERIFICATION_CLIENT_READY, {
      claimantClientId,
      providerCount: bootstrap.recipes.length,
    });
  }

  const builder = ctx.builder;
  const recipe = builder.recipes[builder.providerOrdinal];
  if (!recipe) throw new Error("Builder session has no remaining provider recipes");
  const providerData = builderRecipeToProviderData(recipe, builder.providerOrdinal);
  const attestorAuthRequest = await builder.client.getAttestorAuth(builder.sessionId);
  builder.currentProvider = { recipe, providerData, attestorAuthRequest };

  await builder.client.reportEventBestEffort(
    builder.sessionId,
    BUILDER_EVENTS.VERIFICATION_PROVIDER_STARTED,
    {
      providerId: recipe.providerId,
      resolvedVersion: recipe.resolvedVersion,
      ordinal: builder.providerOrdinal,
      expectedRequestCount: providerData.requestData.length,
    },
  );

  return {
    ...templateData,
    sessionId: builder.sessionId,
    providerId: recipe.providerId,
    applicationId: builderApplicationId(builder.session),
    context: builder.session.context,
    parameters: builderProviderParameters(
      templateData.parameters,
      builder.parameters,
      builder.session.context,
      recipe,
    ),
    callbackUrl: "",
  };
}

async function collectBrowserClaimantDetails() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { device: {}, dimensions: {} };
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const ua = globalThis.navigator?.userAgentData;
        let highEntropy = {};
        try {
          highEntropy =
            (await ua?.getHighEntropyValues?.([
              "architecture",
              "bitness",
              "formFactors",
              "fullVersionList",
              "model",
              "platformVersion",
              "uaFullVersion",
              "wow64",
            ])) ?? {};
        } catch {
          // The browser can withhold high-entropy hints; low-entropy data remains useful.
        }
        return {
          orientation: globalThis.screen?.orientation?.type,
          viewportWidth: globalThis.innerWidth,
          viewportHeight: globalThis.innerHeight,
          displayWidth: Math.round(
            (globalThis.screen?.width ?? 0) * (globalThis.devicePixelRatio ?? 1),
          ),
          displayHeight: Math.round(
            (globalThis.screen?.height ?? 0) * (globalThis.devicePixelRatio ?? 1),
          ),
          userAgentData: ua
            ? {
                ...highEntropy,
                ...(ua.brands ? { brands: ua.brands } : {}),
                ...(typeof ua.mobile === "boolean" ? { mobile: ua.mobile } : {}),
                ...(ua.platform ? { platform: ua.platform } : {}),
              }
            : undefined,
        };
      },
    });
    const value = result?.result;
    if (!value) return { device: {}, dimensions: {} };
    return {
      device: { orientation: value.orientation },
      browser: value.userAgentData ? { userAgentData: value.userAgentData } : {},
      dimensions: {
        viewport: { width: value.viewportWidth, height: value.viewportHeight, unit: "css-px" },
        display: { width: value.displayWidth, height: value.displayHeight, unit: "physical-px" },
      },
    };
  } catch {
    return { device: {}, dimensions: {} };
  }
}

async function completeBuilderProvider(ctx, proofs) {
  const builder = ctx.builder;
  const { recipe, providerData } = builder.currentProvider;
  const requestsByHash = new Map(
    providerData.requestData.map((request) => [request.requestHash, request]),
  );
  const requests = proofs.map((proof) => {
    const providerRequest =
      requestsByHash.get(proof.providerRequest?.requestHash) || proof.providerRequest || {};
    const extractedParameters = proof?.claimData?.params?.paramValues;
    return {
      ...(providerRequest.builderRequestId ? { requestId: providerRequest.builderRequestId } : {}),
      ...(providerRequest.url ? { url: providerRequest.url } : {}),
      ...(providerRequest.method ? { method: providerRequest.method } : {}),
      // Builder receives the extension's exact legacy proof output. Do not
      // deserialize, normalize, or verify nested attestation material here.
      proof,
      ...(extractedParameters && typeof extractedParameters === "object"
        ? { extractedParameters }
        : {}),
    };
  });
  builder.results.push({
    providerId: recipe.providerId,
    resolvedVersion: recipe.resolvedVersion,
    requests,
  });
  builder.proofs.push(...proofs);

  for (const [requestOrdinal, request] of requests.entries()) {
    await builder.client.reportEventBestEffort(
      builder.sessionId,
      BUILDER_EVENTS.REQUEST_CLAIM_COMPLETED,
      {
        providerId: recipe.providerId,
        resolvedVersion: recipe.resolvedVersion,
        ordinal: builder.providerOrdinal,
        requestOrdinal,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        attempt: 1,
      },
    );
  }
  await builder.client.reportEventBestEffort(
    builder.sessionId,
    BUILDER_EVENTS.VERIFICATION_PROVIDER_COMPLETED,
    {
      providerId: recipe.providerId,
      resolvedVersion: recipe.resolvedVersion,
      ordinal: builder.providerOrdinal,
      expectedRequestCount: providerData.requestData.length,
      completedRequestCount: requests.length,
      completedProofCount: requests.length,
    },
  );

  builder.providerOrdinal += 1;
  if (builder.providerOrdinal < builder.recipes.length) {
    await startNextBuilderProvider(ctx);
    return;
  }

  // Reserve the terminal outcome before any asynchronous reporting or result
  // submission. A cancellation or engine failure racing this point must not
  // publish a second, contradictory canonical result.
  if (!claimBuilderTerminal(builder, "success")) return;

  const totals = builderTotals(builder);
  await builder.client.reportEventBestEffort(
    builder.sessionId,
    BUILDER_EVENTS.VERIFICATION_PROOFS_COMPLETED,
    totals,
  );
  await builder.client.reportEventBestEffort(
    builder.sessionId,
    BUILDER_EVENTS.VERIFICATION_RESULT_SUBMITTING,
    {
      ...totals,
      attempt: 1,
    },
  );
  try {
    await builder.client.submitResult(builder.sessionId, {
      status: "success",
      results: builder.results,
    });
    builder.terminal = true;
  } catch (error) {
    await builder.client.reportEventBestEffort(
      builder.sessionId,
      BUILDER_EVENTS.VERIFICATION_RESULT_SUBMISSION_FAILED,
      {
        attempt: 1,
        problem: builderProblem("RESULT_SUBMISSION_FAILED", "Result submission failed", true),
      },
    );
    // Release the success reservation before publishing the durable signed
    // error. Otherwise failSession sees the in-flight success and cannot
    // claim the error terminal outcome after a transient submit failure.
    if (builder.terminal === "success") builder.terminal = null;
    await submitBuilderFailure(ctx, "RESULT_SUBMISSION_FAILED", "Result submission failed");
    throw error;
  }

  await notifyBuilderCompleted(ctx, builder.proofs);
  await finishBuilderSession(ctx);
}

async function startNextBuilderProvider(ctx) {
  const activeTabId = ctx.activeTabId;
  ctx.isBuilderTransition = true;
  try {
    // The next provider may have a different hostname. Remove the previous
    // session rule before its tab is opened; startVerification resets the
    // local rule id while preparing the new provider, so cleanup must happen
    // at the transition boundary.
    await clearBuilderCspRule(ctx, removeCspStrippingRule);
    if (activeTabId) {
      ctx.managedTabs.delete(activeTabId);
      await chrome.tabs.remove(activeTabId);
      ctx.activeTabId = null;
    }
    await startVerification(ctx, {
      sessionId: ctx.builder.sessionId,
      builder: { apiVersion: "2" },
    });
  } finally {
    ctx.isBuilderTransition = false;
  }
}

async function submitBuilderFailure(ctx, reasonCode, title) {
  const builder = ctx.builder;
  if (!claimBuilderTerminal(builder, "error")) return;
  const problem = builderProblem(reasonCode, title, true);
  const result = { status: "error", results: builder.results, problem };
  for (const attempt of [1, 2]) {
    await builder.client.reportEventBestEffort(
      builder.sessionId,
      BUILDER_EVENTS.VERIFICATION_RESULT_SUBMITTING,
      { ...builderTotals(builder), attempt, status: "error" },
    );
    try {
      await builder.client.submitResult(builder.sessionId, result);
      return;
    } catch {
      if (attempt === 1) continue;
    }
    await builder.client.reportEventBestEffort(
      builder.sessionId,
      BUILDER_EVENTS.VERIFICATION_RESULT_SUBMISSION_FAILED,
      {
        attempt,
        problem: builderProblem("RESULT_SUBMISSION_FAILED", "Result submission failed", true),
      },
    );
  }
}

async function submitBuilderTerminal(ctx, status, reasonCode, title, retryable) {
  const builder = ctx.builder;
  if (!builder) return false;
  const problem = builderProblem(reasonCode, title, retryable);
  try {
    await builder.client.reportEventBestEffort(
      ctx.sessionId,
      BUILDER_EVENTS.VERIFICATION_RESULT_SUBMITTING,
      {
        ...builderTotals(builder),
        attempt: 1,
        status,
      },
    );
    await builder.client.submitResult(ctx.sessionId, {
      status,
      results: builder.results,
      problem,
    });
    return true;
  } catch {
    await builder.client.reportEventBestEffort(
      ctx.sessionId,
      BUILDER_EVENTS.VERIFICATION_RESULT_SUBMISSION_FAILED,
      {
        attempt: 1,
        problem: builderProblem("RESULT_SUBMISSION_FAILED", "Result submission failed", true),
      },
    );
    return false;
  }
}

function claimBuilderTerminal(builder, status) {
  if (!builder || builder.terminal) return false;
  builder.terminal = status;
  return true;
}

function invalidateCspRuleTimer(ctx) {
  if (ctx._cspRuleTimer) clearTimeout(ctx._cspRuleTimer);
  ctx._cspRuleTimer = null;
  ctx._cspRuleGeneration = (ctx._cspRuleGeneration || 0) + 1;
}

function hasBuilderConsent(consent) {
  return !!consent && typeof consent === "object" && !Array.isArray(consent)
    ? Object.keys(consent).length > 0
    : !!consent;
}

async function notifyBuilderCompleted(ctx, proofs) {
  const data = { formattedProofs: proofs, submitted: true, sessionId: ctx.sessionId };
  const message = {
    action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
    source: ctx.MESSAGE_SOURCES.BACKGROUND,
    target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
    data,
  };
  if (ctx.activeTabId) await chrome.tabs.sendMessage(ctx.activeTabId, message).catch(() => {});
  if (ctx.originalTabId) await chrome.tabs.sendMessage(ctx.originalTabId, message).catch(() => {});
  await chrome.runtime
    .sendMessage({ action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED, data })
    .catch(() => {});
}

async function finishBuilderSession(ctx) {
  const activeTabId = ctx.activeTabId;
  if (ctx.originalTabId)
    await chrome.tabs.update(ctx.originalTabId, { active: true }).catch(() => {});
  if (activeTabId) await chrome.tabs.remove(activeTabId).catch(() => {});
  if (ctx._cspRuleId) await removeCspStrippingRule().catch(() => {});
  invalidateCspRuleTimer(ctx);
  ctx._cspRuleId = null;
  ctx.activeTabId = null;
  ctx.originalTabId = null;
  ctx.activeSessionId = null;
  ctx.loggingHub.clearSessionContext();
  ctx.builder = null;
  ctx.isBuilderMode = false;
}

function assertBuilderBootstrap(bootstrap, sessionId) {
  if (
    !bootstrap ||
    typeof bootstrap !== "object" ||
    !bootstrap.session ||
    !Array.isArray(bootstrap.recipes)
  ) {
    throw new Error("Builder bootstrap must contain a session and recipes");
  }
  if (bootstrap.session.id && bootstrap.session.id !== sessionId) {
    throw new Error("Builder bootstrap returned a mismatched session");
  }
  if (!bootstrap.recipes.length) throw new Error("Builder session has no recipes");
}

function builderApplicationId(session) {
  const nonceData = session?.context?.attestationNonceData;
  return nonceData?.applicationId || session?.applicationId || session?.appId || "builder";
}

function builderTotals(builder) {
  return {
    expectedProviderCount: builder.recipes.length,
    completedProviderCount: builder.results.length,
    expectedRequestCount: builder.recipes.reduce(
      (count, recipe) => count + (Array.isArray(recipe.requests) ? recipe.requests.length : 0),
      0,
    ),
    completedRequestCount: builder.proofs.length,
    completedProofCount: builder.proofs.length,
  };
}

async function resolveClaimantClientId(value) {
  if (value != null) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
      throw new Error("claimantClientId must be a UUID");
    }
    return value.trim().toLowerCase();
  }

  try {
    const stored = await chrome.storage.local.get(BUILDER_CLAIMANT_ID_STORAGE_KEY);
    const existing = stored?.[BUILDER_CLAIMANT_ID_STORAGE_KEY];
    if (typeof existing === "string" && UUID_PATTERN.test(existing)) return existing;

    const generated = crypto.randomUUID();
    await chrome.storage.local.set({ [BUILDER_CLAIMANT_ID_STORAGE_KEY]: generated });
    return generated;
  } catch {
    // Storage is part of the documented extension permissions. This fallback
    // only covers environments that do not expose it, such as test harnesses.
    return crypto.randomUUID();
  }
}
