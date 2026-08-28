/**
 * Provider documents are authored for several runtimes at once, so their value
 * space is wider than what this SDK implements. These tests pin the coercions,
 * because getting either one wrong fails late and confusingly: an unsupported
 * injectionType strands a session with no interceptor until the timer fires,
 * and an unsupported OPRF mode fails at the attestor after the user has already
 * logged in.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  INJECTION_TYPES,
  DEFAULT_INJECTION_TYPE,
  SUPPORTED_REDACTION_HASH,
  normalizeInjectionType,
  normalizeRedactionHash,
} from "./provider-normalization.js";

/** Collects warn() calls so we can assert a coercion was reported, not silent. */
function recorder() {
  const warnings = [];
  return { logger: { warn: (message) => warnings.push(message) }, warnings };
}

describe("normalizeInjectionType", () => {
  it("passes through the two types the SDK implements", () => {
    assert.equal(normalizeInjectionType("HAWKEYE"), "HAWKEYE");
    assert.equal(normalizeInjectionType("NONE"), "NONE");
  });

  it("falls back to HAWKEYE for the upstream types with no code path here", () => {
    // The full upstream enum is MSWJS | XHOOK | HAWKEYE | NONE | CDP.
    for (const unsupported of ["MSWJS", "XHOOK", "CDP", "UNKNOWN"]) {
      assert.equal(normalizeInjectionType(unsupported), "HAWKEYE", unsupported);
    }
  });

  it("falls back for absent or malformed values", () => {
    for (const bad of [undefined, null, "", "hawkeye", "None", 0, {}]) {
      assert.equal(normalizeInjectionType(bad), DEFAULT_INJECTION_TYPE, JSON.stringify(bad));
    }
  });

  it("never falls back to NONE — that would silently disable interception", () => {
    // Defaulting to NONE looks conservative but means no interceptor is ever
    // injected, so no request is ever matched and the session dies on the timer.
    assert.notEqual(DEFAULT_INJECTION_TYPE, INJECTION_TYPES.NONE);
    assert.equal(DEFAULT_INJECTION_TYPE, "HAWKEYE");
  });

  it("reports a coercion but stays quiet on a supported value", () => {
    const { logger, warnings } = recorder();
    normalizeInjectionType("HAWKEYE", logger);
    normalizeInjectionType("NONE", logger);
    assert.equal(warnings.length, 0);

    normalizeInjectionType("CDP", logger);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /CDP/);
    assert.match(warnings[0], /HAWKEYE/);
  });

  it("works without a logger", () => {
    assert.doesNotThrow(() => normalizeInjectionType("MSWJS"));
  });
});

describe("normalizeRedactionHash", () => {
  it("passes through the one supported OPRF mode", () => {
    assert.equal(normalizeRedactionHash("oprf-raw"), "oprf-raw");
    assert.equal(SUPPORTED_REDACTION_HASH, "oprf-raw");
  });

  it("coerces the other modes the attestor schema allows", () => {
    // Schema enum is oprf | oprf-mpc | oprf-raw.
    assert.equal(normalizeRedactionHash("oprf"), "oprf-raw");
    assert.equal(normalizeRedactionHash("oprf-mpc"), "oprf-raw");
    assert.equal(normalizeRedactionHash("something-else"), "oprf-raw");
  });

  it("leaves an absent hash absent — that is not hashing", () => {
    // Real provider documents carry `hash: null` on non-hashed redactions.
    // Coercing those would hash a value the provider meant to reveal.
    for (const nothing of [null, undefined, "", false, 0]) {
      assert.equal(normalizeRedactionHash(nothing), undefined, JSON.stringify(nothing));
    }
  });

  it("reports a coercion but stays quiet on oprf-raw and on no hash", () => {
    const { logger, warnings } = recorder();
    normalizeRedactionHash("oprf-raw", logger);
    normalizeRedactionHash(null, logger);
    assert.equal(warnings.length, 0);

    normalizeRedactionHash("oprf-mpc", logger);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /oprf-mpc/);
    assert.match(warnings[0], /oprf-raw/);
  });
});
