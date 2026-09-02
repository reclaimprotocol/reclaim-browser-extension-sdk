/**
 * Remove session-scoped state before opening the next Builder provider.
 *
 * The remover is injected so this state transition stays independently
 * testable without loading the service-worker module (whose webpack-oriented
 * imports intentionally omit .js extensions).
 */
export async function clearBuilderCspRule(ctx, removeRule) {
  if (ctx && typeof ctx === "object") {
    if (ctx._cspRuleTimer) clearTimeout(ctx._cspRuleTimer);
    ctx._cspRuleTimer = null;
    ctx._cspRuleGeneration = (ctx._cspRuleGeneration || 0) + 1;
    ctx._cspRuleId = null;
  }
  if (typeof removeRule === "function") await removeRule().catch(() => {});
}
