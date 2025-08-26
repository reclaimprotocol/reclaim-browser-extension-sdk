// Session management for background script
// Handles session start, fail, submit, and timer logic

export async function startVerification(ctx, templateData) {
  try {
    // clear all the member variables
    ctx.providerData = null;
    ctx.parameters = null;
    ctx.httpProviderId = null;
    ctx.appId = null;
    ctx.sessionId = null;
    ctx.callbackUrl = null;
    ctx.generatedProofs = new Map();
    ctx.filteredRequests = new Map();
    ctx.initPopupMessage = new Map();
    ctx.providerDataMessage = new Map();

    // Reset timers and timer state variables
    ctx.sessionTimerManager.clearAllTimers();
    ctx.firstRequestReceived = false;

    // fetch provider data
    if (!templateData.providerId) {
      throw new Error("Provider ID not found");
    }
    // fetch provider data from the backend
    ctx.loggerService.log({
      message: "Fetching provider data from the backend for provider Id " + templateData.providerId,
      type: ctx.LOG_TYPES.BACKGROUND,
      sessionId: templateData.sessionId || "unknown",
      providerId: templateData.providerId || "unknown",
      appId: templateData.applicationId || "unknown",
    });

    const providerData = await ctx.fetchProviderData(
      templateData.providerId,
      templateData.sessionId,
      templateData.applicationId,
    );
    ctx.providerData = providerData;

    ctx.httpProviderId = templateData.providerId;
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
      ctx.loggerService.log({
        message: "New tab created",
        type: ctx.LOG_TYPES.BACKGROUND,
        sessionId: templateData.sessionId || "unknown",
        providerId: templateData.providerId || "unknown",
        appId: templateData.applicationId || "unknown",
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
            httpProviderId: ctx.httpProviderId,
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
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] New tab does not have an ID, cannot queue message for popup.",
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
          ctx.debugLogger.error(
            ctx.DebugLogType.BACKGROUND,
            "[BACKGROUND] Error updating session status:",
            error,
          );
        });
    });

    return {
      success: true,
      message: "Verification started, redirecting to provider login page",
    };
  } catch (error) {
    ctx.debugLogger.error(
      ctx.DebugLogType.BACKGROUND,
      "[BACKGROUND] Error starting verification:",
      error,
    );
    // Release concurrency guard on immediate failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function failSession(ctx, errorMessage, requestHash) {
  ctx.debugLogger.error(ctx.DebugLogType.BACKGROUND, "[BACKGROUND] Failing session:", errorMessage);
  ctx.loggerService.logError({
    error: `Session failed: ${errorMessage}`,
    type: ctx.LOG_TYPES.BACKGROUND,
    sessionId: ctx.sessionId || "unknown",
    providerId: ctx.httpProviderId || "unknown",
    appId: ctx.appId || "unknown",
  });

  // Clear all timers
  ctx.sessionTimerManager.clearAllTimers();

  // Update session status to failed
  if (ctx.sessionId) {
    try {
      await ctx.updateSessionStatus(
        ctx.sessionId,
        ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
        ctx.httpProviderId,
        ctx.appId,
      );
    } catch (error) {
      ctx.debugLogger.error(
        ctx.DebugLogType.BACKGROUND,
        "[BACKGROUND] Error updating session status to failed:",
        error,
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
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error notifying content script of session failure:",
          err,
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

export async function submitProofs(ctx) {
  try {
    ctx.sessionTimerManager.clearAllTimers();

    if (ctx.generatedProofs.size === 0) {
      return;
    }

    if (ctx.generatedProofs.size !== ctx.providerData.requestData.length) {
      return;
    }

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
        await ctx.submitProofOnCallback(
          formattedProofs,
          ctx.callbackUrl,
          ctx.sessionId,
          ctx.httpProviderId,
          ctx.appId,
        );
        submitted = true;
      } catch (error) {
        // Notify original tab
        try {
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
        chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: error.message, sessionId: ctx.sessionId },
        });
        // Broadcast to runtime
        try {
          await chrome.runtime.sendMessage({
            action: ctx.MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
            data: { error: error.message, sessionId: ctx.sessionId },
          });
        } catch (e) {}

        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error submitting my poor proofs:",
          error,
        );
        throw error;
      }
    } else {
      // No callback: set status to generation success
      if (ctx.sessionId) {
        try {
          await ctx.updateSessionStatus(
            ctx.sessionId,
            ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS,
            ctx.httpProviderId,
            ctx.appId,
          );
        } catch (e) {
          ctx.debugLogger.error(
            ctx.DebugLogType.BACKGROUND,
            "[BACKGROUND] Error updating status to PROOF_GENERATION_SUCCESS:",
            e,
          );
        }
      }
    }

    // Notify content script with proofs in both cases
    if (ctx.activeTabId) {
      try {
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (error) {
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error notifying content script:",
          error,
        );
      }
    }

    if (ctx.originalTabId) {
      try {
        await chrome.tabs.sendMessage(ctx.originalTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_SUBMITTED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { formattedProofs, submitted, sessionId: ctx.sessionId },
        });
      } catch (e) {
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error notifying original tab:",
          e,
        );
      }
    }

    // Broadcast to runtime (popup/options)
    try {
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
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error navigating back or closing tab:",
          error,
        );
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
    ctx.debugLogger.error(
      ctx.DebugLogType.BACKGROUND,
      "[BACKGROUND] Error submitting proof:",
      error,
    );
    // Release concurrency guard on failure
    ctx.activeSessionId = null;
    throw error;
  }
}

export async function cancelSession(ctx, sessionId) {
  try {
    ctx.sessionTimerManager.clearAllTimers();

    // Update status as failed due to cancellation (no explicit CANCELLED status available)
    if (ctx.sessionId) {
      try {
        await ctx.updateSessionStatus(
          ctx.sessionId,
          ctx.RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
          ctx.httpProviderId,
          ctx.appId,
        );
      } catch (error) {
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error updating status on cancel:",
          error,
        );
      }
    }

    // Notify content about failure with error message 'Cancelled by user'
    if (ctx.activeTabId) {
      try {
        await chrome.tabs.sendMessage(ctx.activeTabId, {
          action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
          source: ctx.MESSAGE_SOURCES.BACKGROUND,
          target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
          data: { error: "Cancelled by user", sessionId: ctx.sessionId },
        });
      } catch (e) {
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error notifying content on cancel:",
          e,
        );
      }
    }

    // Also forward to the original tab
    if (ctx.originalTabId) {
      try {
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
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error closing tab on cancel:",
          error,
        );
      }
    } else if (ctx.activeTabId) {
      try {
        await chrome.tabs.remove(ctx.activeTabId);
        ctx.activeTabId = null;
      } catch (e) {
        ctx.debugLogger.error(
          ctx.DebugLogType.BACKGROUND,
          "[BACKGROUND] Error closing active tab on cancel:",
          e,
        );
      }
    }

    // Clear queues and session data
    ctx.proofGenerationQueue = [];
    ctx.isProcessingQueue = false;
    ctx.providerData = null;
    ctx.parameters = null;
    ctx.httpProviderId = null;
    ctx.appId = null;
    ctx.sessionId = null;
    ctx.callbackUrl = null;
    ctx.managedTabs.clear();

    // Release guard
    ctx.activeSessionId = null;
  } catch (e) {
    ctx.activeSessionId = null;
    ctx.debugLogger.error(
      ctx.DebugLogType.BACKGROUND,
      "[BACKGROUND] Error during cancelSession:",
      e,
    );
  }
}
