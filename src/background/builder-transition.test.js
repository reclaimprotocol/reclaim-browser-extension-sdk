import assert from "node:assert/strict";
import test from "node:test";

import { clearBuilderCspRule } from "./builder-transition.js";

test("clears the prior CSP rule at a Builder provider transition", async () => {
  const removals = [];
  const ctx = { _cspRuleId: 17 };

  await clearBuilderCspRule(ctx, async () => removals.push(true));

  assert.deepEqual(removals, [true]);
  assert.equal(ctx._cspRuleId, null);
});

test("clears the local CSP state even when rule removal fails", async () => {
  const ctx = { _cspRuleId: 17 };

  await clearBuilderCspRule(ctx, async () => {
    throw new Error("rule already gone");
  });

  assert.equal(ctx._cspRuleId, null);
});

test("invalidates the previous CSP timer at a provider transition", async () => {
  const timer = setTimeout(() => {}, 60_000);
  const ctx = { _cspRuleId: 17, _cspRuleTimer: timer, _cspRuleGeneration: 4 };

  await clearBuilderCspRule(ctx);

  assert.equal(ctx._cspRuleTimer, null);
  assert.equal(ctx._cspRuleGeneration, 5);
  clearTimeout(timer);
});
