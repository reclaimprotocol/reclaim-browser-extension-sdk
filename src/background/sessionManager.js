// Session management for background script
// Handles session start, fail, submit, and timer logic

import { LOG_TYPES, EVENT_TYPES, LOG_LEVEL } from "../utils/logger";

export async function startVerification(ctx, templateData) {
  const bgLogger = ctx.bgLogger;
  try {
    // clear all the member variables
    ctx.providerData = null;
    ctx.parameters = {};
    ctx.providerId = null;
    ctx.appId = null;
    ctx.sessionId = null;
    ctx.callbackUrl = null;
    ctx.generatedProofs = new Map();
    ctx.filteredRequests = new Map();
    ctx.initPopupMessage = new Map();
    ctx.providerDataMessage = new Map();
    ctx.providerRequestsByHash = new Map();
    ctx.aborted = false;

    // Reset timers and timer state variables
    ctx.sessionTimerManager.clearAllTimers();
    ctx.firstRequestReceived = false;

    // fetch provider data
    if (!templateData.providerId) {
      throw new Error("Provider ID not found");
    }
    bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: templateData.sessionId || ctx.sessionId || "unknown",
      providerId: templateData.providerId || ctx.providerId || "unknown",
      appId: templateData.applicationId || ctx.appId || "unknown",
    });
    // fetch provider data from the backend
    bgLogger.info({
      message: `[BACKGROUND] Fetching provider data from the backend for provider Id ${templateData.providerId}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });

    const providerData = await ctx.fetchProviderData(
      templateData.providerId,
      templateData.sessionId,
      templateData.applicationId,
    );

    ctx.providerData = providerData;

    ctx.providerId = templateData.providerId;
    if (templateData.parameters) {
      ctx.parameters = templateData.parameters;
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

    // Create a new tab with provider URL DIRECTLY - not through an async flow
    const providerUrl = providerData.loginUrl;

    // Use chrome.tabs.create directly and handle the promise explicitly
    chrome.tabs.create({ url: providerUrl }, (tab) => {
      ctx.activeTabId = tab.id;
      bgLogger.info({
        message: `[BACKGROUND] New tab created for provider ${templateData.providerId} with tab id ${tab.id}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });

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
          },
        };

        // Initialize the message map if it doesn't exist
        if (!ctx.initPopupMessage) {
          ctx.initPopupMessage = new Map();
        }

        // Store the message in the init PopupMessage for the tab
        ctx.initPopupMessage.set(tab.id, { message: popupMessage });

        // Store the provider data in the providerDataMap for the tab
        ctx.providerDataMessage.set(tab.id, { message: providerDataMessage });
      } else {
        bgLogger.error({
          message: `[BACKGROUND] New tab does not have an ID, cannot queue message for popup.`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }

      bgLogger.info({
        message: `[BACKGROUND] Starting verification with session id: ${ctx.sessionId}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });

      // Update session status after tab creation
      ctx
        .updateSessionStatus(
          templateData.sessionId,
          ctx.RECLAIM_SESSION_STATUS.USER_STARTED_VERIFICATION,
          templateData.providerId,
          templateData.applicationId,
        )
        .catch((error) => {
          bgLogger.error({
            message: `[BACKGROUND] Error updating session status: ${error?.message}`,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
        });
    });

    return {
      success: true,
      message: "Verification started, redirecting to provider login page",
    };
  } catch (error) {
    bgLogger.error({
      message: `[BACKGROUND] Error starting verification: ${error?.message}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });
    // Release concurrency guard on immediate failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function failSession(ctx, errorMessage, requestHash) {
  const bgLogger = ctx.bgLogger;

  bgLogger.setContext({
    type: LOG_TYPES.BACKGROUND,
    sessionId: ctx.sessionId || "unknown",
    providerId: ctx.providerId || "unknown",
    appId: ctx.appId || "unknown",
  });

  bgLogger.log({
    message: `[BACKGROUND] Failing session: ${errorMessage}`,
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.BACKGROUND,
    eventType: EVENT_TYPES.VERIFICATION_FLOW_FAILED,
  });

  // Clear all timers
  ctx.sessionTimerManager.clearAllTimers();

  // abort immediately to stop queue/offscreen processing
  ctx.aborted = true;

  // Update session status to failed
  if (ctx.sessionId) {
    try {
      await ctx.updateSessionStatus(
        ctx.sessionId,
        ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
        ctx.providerId,
        ctx.appId,
      );

      bgLogger.log({
        message: `[BACKGROUND] Updated session status to failed: ${ctx.sessionId}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
    } catch (error) {
      bgLogger.error({
        message: `[BACKGROUND] Error updating session status to failed: ${error?.message}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
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
        bgLogger.error({
          message: `[BACKGROUND] Error notifying content script of session failure: ${err?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      });
  }

  // Also forward to the original tab
  if (ctx.originalTabId) {
    try {
      await chrome.tabs.sendMessage(ctx.originalTabId, {
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { error: errorMessage, sessionId: ctx.sessionId },
      });
    } catch (e) {
      bgLogger.error({
        message: `[BACKGROUND] Error notifying original tab of session failure: ${e?.message}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
    }
  }

  // Broadcast to popup/options pages
  try {
    bgLogger.info({
      message: `[BACKGROUND] Proof generation failed, Broadcasting to popup/options pages: ${errorMessage}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });

    await chrome.runtime.sendMessage({
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
      data: { error: errorMessage, sessionId: ctx.sessionId },
    });
  } catch (e) {
    bgLogger.error({
      message: `[BACKGROUND] Error broadcasting to popup/options pages: ${e?.message}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });
  }

  // Clear the queue
  ctx.proofGenerationQueue = [];
  ctx.isProcessingQueue = false;

  // Release concurrency guard
  ctx.activeSessionId = null;
}

export async function submitProofs(ctx) {
  const bgLogger = ctx.bgLogger;
  try {
    // Hold if user set canExpectManyClaims(true)
    if (ctx.expectManyClaims) return;

    ctx.sessionTimerManager.clearAllTimers();

    bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.providerId || "unknown",
      appId: ctx.appId || "unknown",
    });

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
          formattedProofs.push(ctx.formatProof(proof, rd));
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
      formattedProofs.push(ctx.formatProof(proof, providerRequest));
    }

    const finalProofs = formattedProofs.map((fp) => ({
      ...fp,
      publicData: ctx.publicData ?? null,
    }));

    bgLogger.info({
      message: `[BACKGROUND] Submitting proofs ${JSON.stringify(finalProofs)}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      eventType: EVENT_TYPES.SUBMITTING_PROOF,
    });

    let submitted = false;
    // If callbackUrl provided, submit; otherwise just signal completion
    if (ctx.callbackUrl && typeof ctx.callbackUrl === "string" && ctx.callbackUrl.length > 0) {
      try {
        bgLogger.log({
          message: `[BACKGROUND] Submitting proofs to callback URL: ${ctx.callbackUrl}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
          eventType: EVENT_TYPES.SUBMITTING_PROOF_TO_CALLBACK_URL,
        });
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
          bgLogger.error({
            message: `[BACKGROUND] Notifying original tab of proof submission failure: ${error.message}`,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
            eventType: EVENT_TYPES.SUBMITTING_PROOF_TO_CALLBACK_URL_FAILED,
          });
          await chrome.tabs.sendMessage(ctx.originalTabId, {
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            source: ctx.MESSAGE_SOURCES.BACKGROUND,
            target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {
          bgLogger.error({
            message: `[BACKGROUND] Error notifying original tab of proof submission failure: ${e?.message}`,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
            eventType: EVENT_TYPES.SUBMITTING_PROOF_TO_CALLBACK_URL_FAILED,
          });
        }

        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: error.message, sessionId: ctx.sessionId },
        });

        bgLogger.error({
          message: `[BACKGROUND] Broadcasting to runtime of proof submission failure: ${error.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
          eventType: EVENT_TYPES.PROOF_SUBMISSION_FAILED,
        });
        // Broadcast to runtime
        try {
          await chrome.runtime.sendMessage({
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {}

        bgLogger.error({
          message: `[BACKGROUND] Error submitting proofs: ${error.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        throw error;
      }
    } else {
      // No callback: set status to generation success
      if (ctx.sessionId) {
        try {
          bgLogger.log({
            message: `[BACKGROUND] Updating status to PROOF_GENERATION_SUCCESS`,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
            eventType: EVENT_TYPES.PROOF_SUBMITTED,
          });
          await ctx.updateSessionStatus(
            ctx.sessionId,
            ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS,
            ctx.providerId,
            ctx.appId,
          );
        } catch (e) {
          bgLogger.error({
            message: `[BACKGROUND] Error updating status to PROOF_GENERATION_SUCCESS: ${e?.message}`,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.BACKGROUND,
          });
        }
      }
    }

    // Notify content script with proofs in both cases
    if (ctx.activeTabId) {
      try {
        bgLogger.log({
          message: `[BACKGROUND] Proof submitted, Notifying content script with proofs`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (error) {
        bgLogger.error({
          message: `[BACKGROUND] Error notifying content script: ${error?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    }

    if (ctx.originalTabId) {
      try {
        bgLogger.log({
          message: `[BACKGROUND] Proof submitted, Notifying original tab with proofs`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });

        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (e) {
        bgLogger.error({
          message: `[BACKGROUND] Error notifying original tab: ${e?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    }

    // Broadcast to runtime (popup/options)
    try {
      bgLogger.log({
        message: `[BACKGROUND] Proof submitted, Broadcasting to runtime`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
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
        }, 3000);
      } catch (error) {
        bgLogger.error({
          message: `[BACKGROUND] Error navigating back or closing tab: ${error?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    } else if (ctx.activeTabId) {
      // Fallback: started from panel/popup, no original tab to return to
      try {
        setTimeout(async () => {
          await chrome.tabs.remove(ctx.activeTabId);
          ctx.activeTabId = null;
        }, 3000);
      } catch (e) {
        /* ignore */
      }
    }
    // Release concurrency guard on success
    ctx.activeSessionId = null;
    return { success: true };
  } catch (error) {
    bgLogger.error({
      message: `[BACKGROUND] Error submitting proof: ${error?.message}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      eventType: EVENT_TYPES.PROOF_SUBMISSION_FAILED,
    });
    // Release concurrency guard on failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function cancelSession(ctx) {
  const bgLogger = ctx.bgLogger;
  try {
    bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.providerId || "unknown",
      appId: ctx.appId || "unknown",
    });
    bgLogger.log({
      message: `[BACKGROUND] Cancelling session`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      eventType: EVENT_TYPES.RECLAIM_VERIFICATION_DISMISSED,
    });

    ctx.sessionTimerManager.clearAllTimers();

    // abort immediately to stop queue/offscreen processing
    ctx.aborted = true;

    // Update status as failed due to cancellation (no explicit CANCELLED status available)
    if (ctx.sessionId) {
      try {
        bgLogger.log({
          message: `[BACKGROUND] Proof generation failed, Updating status on cancel`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        await ctx.updateSessionStatus(
          ctx.sessionId,
          ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
          ctx.providerId,
          ctx.appId,
        );
      } catch (error) {
        bgLogger.error({
          message: `[BACKGROUND] Error updating status on cancel: ${error?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    }

    // Notify content about failure with error message 'Cancelled by user'
    if (ctx.activeTabId) {
      try {
        bgLogger.log({
          message: `[BACKGROUND] Proof generation failed, Notifying content on cancel`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        bgLogger.error({
          message: `[BACKGROUND] Error notifying content on cancel: ${e?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    }

    // Also forward to the original tab
    if (ctx.originalTabId) {
      try {
        bgLogger.log({
          message: `[BACKGROUND] Proof generation failed, Notifying original tab on cancel`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        /* ignore */
        bgLogger.error({
          message: `[BACKGROUND] Error notifying original tab on cancel: ${e?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    }

    // Broadcast to runtime
    try {
      bgLogger.log({
        message: `[BACKGROUND] Proof generation failed, Broadcasting to runtime on cancel`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
      await chrome.runtime.sendMessage({
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
        data: { error: "Cancelled by user", sessionId: ctx.sessionId },
      });
    } catch (e) {
      bgLogger.error({
        message: `[BACKGROUND] Error broadcasting to runtime on cancel: ${e?.message}`,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
    }

    // Close managed tab and restore original if available
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
        bgLogger.error({
          message: `[BACKGROUND] Error closing tab on cancel: ${error?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    } else if (ctx.activeTabId) {
      try {
        await chrome.tabs.remove(ctx.activeTabId);
        ctx.activeTabId = null;
      } catch (e) {
        bgLogger.error({
          message: `[BACKGROUND] Error closing active tab on cancel: ${e?.message}`,
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
        });
      }
    }

    // Clear queues and session data
    ctx.proofGenerationQueue = [];
    ctx.isProcessingQueue = false;
    ctx.providerData = null;
    ctx.parameters = {};
    ctx.providerId = null;
    ctx.appId = null;
    ctx.sessionId = null;
    ctx.callbackUrl = null;
    ctx.providerRequestsByHash = new Map();
    ctx.managedTabs.clear();

    // Release guard
    ctx.activeSessionId = null;
  } catch (e) {
    ctx.activeSessionId = null;
    bgLogger.error({
      message: `[BACKGROUND] Error during cancelSession: ${e?.message}`,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });
  }
}
