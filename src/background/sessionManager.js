// Session management for background script
// Handles session start, fail, submit, and timer logic

import { LOG_TYPES } from "../utils/logger";

export async function startVerification(ctx, templateData) {
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
    ctx.bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: templateData.sessionId || ctx.sessionId || "unknown",
      providerId: templateData.providerId || ctx.providerId || "unknown",
      appId: templateData.applicationId || ctx.appId || "unknown",
    });
    // fetch provider data from the backend
    ctx.bgLogger.info(
      `[BACKGROUND] Fetching provider data from the backend for provider Id ${templateData.providerId}`,
    );

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
      ctx.bgLogger.info(
        `[BACKGROUND] New tab created for provider ${templateData.providerId} with tab id ${tab.id}`,
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
        ctx.bgLogger.error(
          `[BACKGROUND] New tab does not have an ID, cannot queue message for popup.`,
        );
      }

      // Update session status after tab creation
      ctx
        .updateSessionStatus(
          templateData.sessionId,
          ctx.RECLAIM_SESSION_STATUS.USER_STARTED_VERIFICATION,
          templateData.providerId,
          templateData.applicationId,
        )
        .catch((error) => {
          ctx.bgLogger.error(`[BACKGROUND] Error updating session status: ${error?.message}`);
        });
    });

    return {
      success: true,
      message: "Verification started, redirecting to provider login page",
    };
  } catch (error) {
    ctx.bgLogger.error(`[BACKGROUND] Error starting verification: ${error?.message}`);
    // Release concurrency guard on immediate failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function failSession(ctx, errorMessage, requestHash) {
  ctx.bgLogger.setContext({
    type: LOG_TYPES.BACKGROUND,
    sessionId: ctx.sessionId || "unknown",
    providerId: ctx.providerId || "unknown",
    appId: ctx.appId || "unknown",
  });

  ctx.bgLogger.error(`[BACKGROUND] Failing session: ${errorMessage}`);

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
      ctx.bgLogger.info(`[BACKGROUND] Updated session status to failed: ${ctx.sessionId}`);
    } catch (error) {
      ctx.bgLogger.error(`[BACKGROUND] Error updating session status to failed: ${error?.message}`);
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
        ctx.bgLogger.error(
          `[BACKGROUND] Error notifying content script of session failure: ${err?.message}`,
        );
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
      /* ignore */
    }
  }

  // Broadcast to popup/options pages
  try {
    ctx.bgLogger.info(
      `[BACKGROUND] Proof generation failed, Broadcasting to popup/options pages: ${errorMessage}`,
    );
    await chrome.runtime.sendMessage({
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
      data: { error: errorMessage, sessionId: ctx.sessionId },
    });
  } catch (e) {}

  // Clear the queue
  ctx.proofGenerationQueue = [];
  ctx.isProcessingQueue = false;

  // Release concurrency guard
  ctx.activeSessionId = null;
}

export async function submitProofs2(ctx) {
  try {
    if (ctx.generatedProofs.size === 0) {
      return;
    }

    if (ctx.generatedProofs.size !== ctx.providerData.requestData.length) {
      return;
    }

    if (ctx.expectManyClaims) {
      return;
    }

    ctx.bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.providerId || "unknown",
      appId: ctx.appId || "unknown",
    });

    ctx.bgLogger.info(`[BACKGROUND] Submitting proofs...`);

    ctx.sessionTimerManager.clearAllTimers();

    let formattedProofs = [];
    for (const requestData of ctx.providerData.requestData) {
      if (ctx.generatedProofs.has(requestData.requestHash)) {
        const proof = ctx.generatedProofs.get(requestData.requestHash);
        const formattedProof = ctx.formatProof(proof, requestData);
        formattedProofs.push(formattedProof);
      }
    }

    // after building formattedProofs[]
    formattedProofs = formattedProofs.map((fp) => ({
      ...fp,
      publicData: ctx.publicData ?? null,
    }));

    let submitted = false;
    // If callbackUrl provided, submit; otherwise just signal completion
    if (ctx.callbackUrl && typeof ctx.callbackUrl === "string" && ctx.callbackUrl.length > 0) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Submitting proofs to callback URL: ${ctx.callbackUrl}`);
        await ctx.submitProofOnCallback(
          formattedProofs,
          ctx.callbackUrl,
          ctx.sessionId,
          ctx.providerId,
          ctx.appId,
        );
        submitted = true;
      } catch (error) {
        // Notify original tab
        try {
          ctx.bgLogger.info(
            `[BACKGROUND] Notifying original tab of proof submission failure: ${error.message}`,
          );
          await chrome.tabs.sendMessage(ctx.originalTabId, {
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            source: ctx.MESSAGE_SOURCES.BACKGROUND,
            target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {
          /* ignore */
        }
        // Notify active tab
        ctx.bgLogger.info(
          `[BACKGROUND] Notifying active tab of proof submission failure: ${error.message}`,
        );
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: error.message, sessionId: ctx.sessionId },
        });
        // Broadcast to runtime
        try {
          ctx.bgLogger.info(
            `[BACKGROUND] Broadcasting to runtime of proof submission failure: ${error.message}`,
          );
          await chrome.runtime.sendMessage({
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {}

        ctx.bgLogger.error(`[BACKGROUND] Error submitting my poor proofs: ${error.message}`);

        throw error;
      }
    } else {
      // No callback: set status to generation success
      if (ctx.sessionId) {
        try {
          ctx.bgLogger.info(`[BACKGROUND] Updating status to PROOF_GENERATION_SUCCESS`);
          await ctx.updateSessionStatus(
            ctx.sessionId,
            ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS,
            ctx.providerId,
            ctx.appId,
          );
        } catch (e) {
          ctx.bgLogger.error(
            `[BACKGROUND] Error updating status to PROOF_GENERATION_SUCCESS: ${e?.message}`,
          );
        }
      }
    }

    // Notify content script with proofs in both cases
    if (ctx.activeTabId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof submitted, Notifying content script with proofs`);
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (error) {
        ctx.bgLogger.error(`[BACKGROUND] Error notifying content script: ${error?.message}`);
      }
    }

    if (ctx.originalTabId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof submitted, Notifying original tab with proofs`);
        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (e) {
        ctx.bgLogger.error(`[BACKGROUND] Error notifying original tab: ${e?.message}`);
      }
    }

    // Broadcast to runtime (popup/options)
    try {
      ctx.bgLogger.info(`[BACKGROUND] Proof submitted, Broadcasting to runtime`);
      await chrome.runtime.sendMessage({
        action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
        data: { formattedProofs, submitted, sessionId: ctx.sessionId },
      });
    } catch (e) {
      ctx.bgLogger.error(`[BACKGROUND] Error broadcasting to runtime: ${e?.message}`);
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
        }, 3000);
      } catch (error) {
        ctx.bgLogger.error(`[BACKGROUND] Error navigating back or closing tab: ${error?.message}`);
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
    ctx.bgLogger.error(`[BACKGROUND] Error submitting proof: ${error?.message}`);
    // Release concurrency guard on failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function submitProofs(ctx) {
  try {
    // Hold if user set canExpectManyClaims(true)
    if (ctx.expectManyClaims) return;

    ctx.sessionTimerManager.clearAllTimers();

    ctx.bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.providerId || "unknown",
      appId: ctx.appId || "unknown",
    });

    ctx.bgLogger.info(`[BACKGROUND] Submitting proofs!!!`);

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

    console.log("finalProofs", { finalProofs });

    let submitted = false;
    // If callbackUrl provided, submit; otherwise just signal completion
    if (ctx.callbackUrl && typeof ctx.callbackUrl === "string" && ctx.callbackUrl.length > 0) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Submitting proofs to callback URL: ${ctx.callbackUrl}`);
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
          ctx.bgLogger.info(
            `[BACKGROUND] Notifying original tab of proof submission failure: ${error.message}`,
          );
          await chrome.tabs.sendMessage(ctx.originalTabId, {
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            source: ctx.MESSAGE_SOURCES.BACKGROUND,
            target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {
          /* ignore */
          ctx.bgLogger.error(
            `[BACKGROUND] Error notifying original tab of proof submission failure: ${e?.message}`,
          );
        }
        // Notify active tab
        ctx.bgLogger.info(
          `[BACKGROUND] Notifying active tab of proof submission failure: ${error.message}`,
        );
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: error.message, sessionId: ctx.sessionId },
        });
        // Broadcast to runtime
        try {
          ctx.bgLogger.info(
            `[BACKGROUND] Broadcasting to runtime of proof submission failure: ${error.message}`,
          );
          await chrome.runtime.sendMessage({
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {}

        ctx.bgLogger.error(`[BACKGROUND] Error submitting my poor proofs: ${error.message}`);
        throw error;
      }
    } else {
      // No callback: set status to generation success
      if (ctx.sessionId) {
        try {
          ctx.bgLogger.info(`[BACKGROUND] Updating status to PROOF_GENERATION_SUCCESS`);
          await ctx.updateSessionStatus(
            ctx.sessionId,
            ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS,
            ctx.providerId,
            ctx.appId,
          );
        } catch (e) {
          ctx.bgLogger.error(
            `[BACKGROUND] Error updating status to PROOF_GENERATION_SUCCESS: ${e?.message}`,
          );
        }
      }
    }

    // Notify content script with proofs in both cases
    if (ctx.activeTabId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof submitted, Notifying content script with proofs`);
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (error) {
        ctx.bgLogger.error(`[BACKGROUND] Error notifying content script: ${error?.message}`);
      }
    }

    if (ctx.originalTabId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof submitted, Notifying original tab with proofs`);
        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (e) {
        ctx.bgLogger.error(`[BACKGROUND] Error notifying original tab: ${e?.message}`);
      }
    }

    // Broadcast to runtime (popup/options)
    try {
      ctx.bgLogger.info(`[BACKGROUND] Proof submitted, Broadcasting to runtime`);
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
        ctx.bgLogger.error(`[BACKGROUND] Error navigating back or closing tab: ${error?.message}`);
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
    console.log(error);
    ctx.bgLogger.error(`[BACKGROUND] Error submitting proof: ${error?.message}`);
    // Release concurrency guard on failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function cancelSession(ctx, sessionId) {
  try {
    ctx.bgLogger.setContext({
      type: LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.providerId || "unknown",
      appId: ctx.appId || "unknown",
    });
    ctx.bgLogger.info(`[BACKGROUND] Cancelling session`);

    ctx.sessionTimerManager.clearAllTimers();

    // abort immediately to stop queue/offscreen processing
    ctx.aborted = true;

    // Update status as failed due to cancellation (no explicit CANCELLED status available)
    if (ctx.sessionId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof generation failed, Updating status on cancel`);
        await ctx.updateSessionStatus(
          ctx.sessionId,
          ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
          ctx.providerId,
          ctx.appId,
        );
      } catch (error) {
        ctx.bgLogger.error(`[BACKGROUND] Error updating status on cancel: ${error?.message}`);
      }
    }

    // Notify content about failure with error message 'Cancelled by user'
    if (ctx.activeTabId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof generation failed, Notifying content on cancel`);
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        ctx.bgLogger.error(`[BACKGROUND] Error notifying content on cancel: ${e?.message}`);
      }
    }

    // Also forward to the original tab
    if (ctx.originalTabId) {
      try {
        ctx.bgLogger.info(`[BACKGROUND] Proof generation failed, Notifying original tab on cancel`);
        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        /* ignore */
      }
    }

    // Broadcast to runtime
    try {
      ctx.bgLogger.info(`[BACKGROUND] Proof generation failed, Broadcasting to runtime on cancel`);
      await chrome.runtime.sendMessage({
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
        data: { error: "Cancelled by user", sessionId: ctx.sessionId },
      });
    } catch (e) {}

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
        ctx.bgLogger.error(`[BACKGROUND] Error closing tab on cancel: ${error?.message}`);
      }
    } else if (ctx.activeTabId) {
      try {
        await chrome.tabs.remove(ctx.activeTabId);
        ctx.activeTabId = null;
      } catch (e) {
        ctx.bgLogger.error(`[BACKGROUND] Error closing active tab on cancel: ${e?.message}`);
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
    ctx.bgLogger.error(`[BACKGROUND] Error during cancelSession: ${e?.message}`);
  }
}
