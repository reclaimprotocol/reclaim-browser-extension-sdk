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
  const { loggingHub } = ctx;

  if (ctx.aborted) {
    loggingHub.info("[BACKGROUND] Proof generation queue aborted", "background.proofQueue");
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
      loggingHub.info("[BACKGROUND] Proof generation aborted", "background.proofQueue");
      return;
    }

    chrome.tabs.sendMessage(ctx.activeTabId, {
      action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_STARTED,
      source: ctx.MESSAGE_SOURCES.BACKGROUND,
      target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
      data: { requestHash: task.requestHash },
    });

    loggingHub.info(
      "[BACKGROUND] Proof generation started for request hash: " + task.requestHash,
      "background.proofQueue",
    );

    const proofResponseObject = await ctx.generateProof(
      {
        ...task.claimData,
        publicData: ctx.publicData ?? null,
      },
      loggingHub,
    );

    if (ctx.aborted) {
      loggingHub.info("[BACKGROUND] Proof generation aborted", "background.proofQueue");
      return;
    }

    if (!proofResponseObject.success) {
      loggingHub.error(
        "[BACKGROUND] Proof generation failed for request hash: " +
          task.requestHash +
          ": " +
          proofResponseObject.error,
        "background.proofQueue",
      );
      ctx.failSession("Proof generation failed: " + proofResponseObject.error, task.requestHash);
      return;
    }

    const proof = proofResponseObject.proof;

    if (proof) {
      if (!ctx.generatedProofs.has(task.requestHash)) {
        ctx.generatedProofs.set(task.requestHash, proof);
      }

      loggingHub.info(
        "[BACKGROUND] Proof generation successful for request hash: " + task.requestHash,
        "background.proofQueue",
      );

      chrome.tabs.sendMessage(ctx.activeTabId, {
        action: ctx.MESSAGE_ACTIONS.PROOF_GENERATION_SUCCESS,
        source: ctx.MESSAGE_SOURCES.BACKGROUND,
        target: ctx.MESSAGE_SOURCES.CONTENT_SCRIPT,
        data: { requestHash: task.requestHash },
      });

      ctx.sessionTimerManager.resetSessionTimer();
    }
  } catch (error) {
    loggingHub.error(
      "[BACKGROUND] Proof generation failed for request hash: " +
        task.requestHash +
        ": " +
        error?.message,
      "background.proofQueue",
    );

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
