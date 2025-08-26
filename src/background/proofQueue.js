// Proof generation queue for background script
// Handles the proof generation queue and related logic

import { debugLogger, DebugLogType } from "../utils/logger";

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
  if (ctx.aborted) return; // stop immediately
  if (ctx.isProcessingQueue || ctx.proofGenerationQueue.length === 0) {
    if (ctx.proofGenerationQueue.length === 0) {
      if (ctx.generatedProofs.size === ctx.providerData.requestData.length) {
        ctx.sessionTimerManager.clearAllTimers();
        if (!ctx.expectManyClaims) {
          setTimeout(() => ctx.submitProofs(), 0);
        }
        // else: hold until canExpectManyClaims(false)
      } else {
        ctx.sessionTimerManager.resumeSessionTimer();
      }
      return;
    }
    ctx.sessionTimerManager.resumeSessionTimer();
  }

  ctx.isProcessingQueue = true;

  const task = ctx.proofGenerationQueue.shift();

  try {
    if (ctx.aborted) return;
    chrome.tabs.sendMessage(ctx.activeTabId, {
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_STARTED,
      source: ctx.MESSAGE_SOURCES.BACKGROUND,
      target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
      data: { requestHash: task.requestHash },
    });

    ctx.loggerService.log({
      message: `Queued proof generation request for request hash: ${task.requestHash}`,
      type: ctx.LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.httpProviderId || "unknown",
      appId: ctx.appId || "unknown",
    });
    const proofResponseObject = await ctx.generateProof({
      ...task.claimData,
      publicData: ctx.publicData ?? null,
    });

    if (ctx.aborted) return;

    if (!proofResponseObject.success) {
      ctx.failSession("Proof generation failed: " + proofResponseObject.error, task.requestHash);
      return;
    }

    const proof = proofResponseObject.proof;

    if (proof) {
      if (!ctx.generatedProofs.has(task.requestHash)) {
        ctx.generatedProofs.set(task.requestHash, proof);
      }

      ctx.loggerService.log({
        message: `Proof generation successful for request hash: ${task.requestHash}`,
        type: ctx.LOG_TYPES.BACKGROUND,
        sessionId: ctx.sessionId || "unknown",
        providerId: ctx.httpProviderId || "unknown",
        appId: ctx.appId || "unknown",
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
    debugLogger.error(
      DebugLogType.BACKGROUND,
      "Error processing proof generation queue item:",
      error,
    );
    ctx.loggerService.logError({
      error: `Proof generation failed for request hash: ${task.requestHash}`,
      type: ctx.LOG_TYPES.BACKGROUND,
      sessionId: ctx.sessionId || "unknown",
      providerId: ctx.httpProviderId || "unknown",
      appId: ctx.appId || "unknown",
    });

    ctx.failSession("Proof generation failed: " + error.message, task.requestHash);
    return;
  } finally {
    ctx.isProcessingQueue = false;

    if (ctx.aborted) return;

    if (ctx.proofGenerationQueue.length > 0) {
      processNextQueueItem(ctx);
    } else {
      if (ctx.generatedProofs.size === ctx.providerData.requestData.length) {
        ctx.sessionTimerManager.clearAllTimers();
        if (!ctx.expectManyClaims) {
          setTimeout(() => ctx.submitProofs(), 0);
        }
        // else: hold until canExpectManyClaims(false)
      } else {
        ctx.sessionTimerManager.resumeSessionTimer();
      }
    }
  }
}
