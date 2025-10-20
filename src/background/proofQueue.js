import { LOG_TYPES, LOG_LEVEL, EVENT_TYPES } from "../utils/logger";

export function addToProofGenerationQueue(ctx, claimData, requestHash) {
  ctx.proofGenerationQueue.push({
    claimData,
    requestHash,
  });

  if (!ctx.isProcessingQueue) {
    ctx.sessionTimerManager.pauseSessionTimer();
    processNextQueueItem(ctx);
  }
}

export async function processNextQueueItem(ctx) {
  const bgLogger = ctx.bgLogger;
  bgLogger.setContext({
    sessionId: ctx.sessionId || "unknown",
    providerId: ctx.providerId || "unknown",
    appId: ctx.appId || "unknown",
    type: LOG_TYPES.BACKGROUND,
  });

  if (ctx.aborted) {
    bgLogger.info({
      message: "[BACKGROUND] Proof generation queue aborted",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      eventType: EVENT_TYPES.RECLAIM_VERIFICATION_DISMISSED,
    });
    return;
  }

  if (ctx.isProcessingQueue || ctx.proofGenerationQueue.length === 0) {
    if (ctx.proofGenerationQueue.length === 0) {
      const templateCount = Array.isArray(ctx.providerData?.requestData)
        ? ctx.providerData.requestData.length
        : 0;

      if (templateCount > 0) {
        const completedTemplate = ctx.providerData.requestData.filter((rd) =>
          ctx.generatedProofs.has(rd.requestHash),
        ).length;

        if (completedTemplate === templateCount) {
          ctx.sessionTimerManager.clearAllTimers();
          if (!ctx.expectManyClaims) setTimeout(() => ctx.submitProofs(), 0);
        } else {
          ctx.sessionTimerManager.resumeSessionTimer();
        }
      } else {
        // Manual mode: queue is empty → submit whatever we have
        ctx.sessionTimerManager.clearAllTimers();
        if (!ctx.expectManyClaims) setTimeout(() => ctx.submitProofs(), 0);
      }
      return;
    }
    ctx.sessionTimerManager.resumeSessionTimer();
  }

  ctx.isProcessingQueue = true;

  const task = ctx.proofGenerationQueue.shift();

  try {
    if (ctx.aborted) {
      bgLogger.info({
        message: "[BACKGROUND] Proof generation aborted",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
        eventType: EVENT_TYPES.PROOF_GENERATION_ABORTED,
      });
      return;
    }

    chrome.tabs.sendMessage(ctx.activeTabId, {
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_STARTED,
      source: ctx.MESSAGE_SOURCES.BACKGROUND,
      target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
      data: { requestHash: task.requestHash },
    });

    bgLogger.info({
      message: "[BACKGROUND] Proof generation started for request hash: " + task.requestHash,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });

    const proofResponseObject = await ctx.generateProof(
      {
        ...task.claimData,
        publicData: ctx.publicData ?? null,
      },
      bgLogger,
    );

    if (ctx.aborted) {
      bgLogger.info({
        message: "[BACKGROUND] Proof generation aborted",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
        eventType: EVENT_TYPES.PROOF_GENERATION_ABORTED,
      });
      return;
    }

    if (!proofResponseObject.success) {
      bgLogger.error({
        message:
          "[BACKGROUND] Proof generation failed for request hash: " +
          task.requestHash +
          ": " +
          proofResponseObject.error,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });
      ctx.failSession("Proof generation failed: " + proofResponseObject.error, task.requestHash);
      return;
    }

    const proof = proofResponseObject.proof;

    if (proof) {
      if (!ctx.generatedProofs.has(task.requestHash)) {
        ctx.generatedProofs.set(task.requestHash, proof);
      }

      bgLogger.info({
        message: "[BACKGROUND] Proof generation successful for request hash: " + task.requestHash,
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
      });

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_SUCCESS,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { requestHash: task.requestHash },
      });

      ctx.sessionTimerManager.resetSessionTimer();
    }
  } catch (error) {
    bgLogger.error({
      message:
        "[BACKGROUND] Proof generation failed for request hash: " +
        task.requestHash +
        ": " +
        error?.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
    });

    ctx.failSession("Proof generation failed: " + error.message, task.requestHash);
    return;
  } finally {
    ctx.isProcessingQueue = false;

    if (ctx.aborted) return;

    if (ctx.proofGenerationQueue.length > 0) {
      processNextQueueItem(ctx);
    } else {
      const templateCount = Array.isArray(ctx.providerData?.requestData)
        ? ctx.providerData.requestData.length
        : 0;

      if (templateCount > 0) {
        const completedTemplate = ctx.providerData.requestData.filter((rd) =>
          ctx.generatedProofs.has(rd.requestHash),
        ).length;

        ctx.sessionTimerManager.clearAllTimers();
        if (completedTemplate === templateCount) {
          if (!ctx.expectManyClaims) setTimeout(() => ctx.submitProofs(), 0);
        } else {
          ctx.sessionTimerManager.resumeSessionTimer();
        }
      } else {
        // Manual mode: queue is empty → submit whatever we have
        ctx.sessionTimerManager.clearAllTimers();
        if (!ctx.expectManyClaims) setTimeout(() => ctx.submitProofs(), 0);
      }
    }
  }
}
