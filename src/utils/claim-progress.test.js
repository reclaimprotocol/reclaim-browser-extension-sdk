/**
 * The popup's claim counter, for the case that broke it.
 *
 * Session 2b46b57c39 ran the `example` provider: three requestData entries
 * across three ORIGINS (example.org -> example.com -> jsonplaceholder). All
 * three claims and proofs succeeded, but the popup showed `1/1`, flashed
 * `2/1`, and settled back on `1/1`.
 *
 * The cause was not the counting logic — it was WHERE the counting lived. The
 * popup belongs to the content script, which Chrome tears down and rebuilds at
 * `document_start` on every navigation, so each new page got a fresh
 * `{ totalClaims: 0, completedClaims: 0 }` and could only see the events that
 * arrived after it existed. The last page saw one claim request and three proof
 * successes: 1/1, 2/1, 3/1 — then `showSuccess()` printed
 * `totalClaims/totalClaims`, i.e. 1/1 again.
 *
 * These tests pin the replacement: the background computes progress from state
 * that survives navigation, and the popup only renders it.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { claimProgress } from "./claim-progress.js";

/** A ctx as background.js builds it, mid-session. */
const ctx = (proofCount, requestDataCount) => ({
  generatedProofs: new Map(
    Array.from({ length: proofCount }, (_, i) => [`0xhash${i}`, { proof: i }]),
  ),
  providerData: { requestData: Array.from({ length: requestDataCount }, () => ({})) },
});

describe("claimProgress", () => {
  it("reports the provider's full request count from the very first claim", () => {
    // The whole point: at the moment the FIRST claim is requested the
    // denominator is already 3, so a popup built on page 3 of 3 still renders
    // the session's totals rather than its own page's.
    assert.deepEqual(claimProgress(ctx(0, 3)), { completed: 0, total: 3 });
  });

  it("walks the example provider's session to 3/3", () => {
    assert.deepEqual(claimProgress(ctx(1, 3)), { completed: 1, total: 3 });
    assert.deepEqual(claimProgress(ctx(2, 3)), { completed: 2, total: 3 });
    assert.deepEqual(claimProgress(ctx(3, 3)), { completed: 3, total: 3 });
  });

  it("never reports more completed than total", () => {
    // What produced the nonsensical `2/1`. With expectManyClaims a provider
    // script can generate more claims than requestData declares, so the total
    // grows to meet them instead of the counter overflowing.
    assert.deepEqual(claimProgress(ctx(4, 3)), { completed: 4, total: 4 });
  });

  it("survives provider data that is missing or malformed", () => {
    // Runs before fetchProviderData resolves, and on the failure path.
    assert.deepEqual(claimProgress({}), { completed: 0, total: 0 });
    assert.deepEqual(claimProgress({ generatedProofs: new Map() }), { completed: 0, total: 0 });
    assert.deepEqual(
      claimProgress({ generatedProofs: new Map([["a", 1]]), providerData: {} }),
      { completed: 1, total: 1 },
      "a proof with no declared requestData still counts",
    );
    assert.deepEqual(claimProgress(undefined), { completed: 0, total: 0 });
  });
});
