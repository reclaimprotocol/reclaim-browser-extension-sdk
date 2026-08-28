/**
 * The attestor validates `params`/`secretParams` with AJV against schemas that
 * are `additionalProperties: false`, server-side, at proof time. Anything extra
 * fails the whole claim with a message that does not name the field — after the
 * user has already logged in. These tests pin the local gate that prevents that.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { assertClaimShape } from "./claim-shape.js";

describe("assertClaimShape", () => {
  const noopLogger = { error() {}, warn() {} };

  it("strips params keys the attestor schema does not declare", () => {
    // responseSelections is a real legacy provider field with no schema
    // counterpart; it used to be copied straight into params.
    const params = {
      url: "https://x/y",
      method: "GET",
      responseMatches: [{ value: "a", type: "contains" }],
      responseSelections: [{ value: "a" }],
      order: 1,
    };
    assertClaimShape(params, {}, noopLogger);

    assert.ok(!("responseSelections" in params));
    assert.ok(!("order" in params));
    assert.equal(params.url, "https://x/y");
  });

  it("keeps every key the schema does declare", () => {
    const params = {
      url: "https://x/y",
      method: "POST",
      geoLocation: "",
      proxySessionId: "abcd1234",
      headers: { Accept: "application/json" },
      body: "{}",
      writeRedactionMode: "zk",
      additionalClientOptions: { supportedProtocolVersions: ["TLS1_3"] },
      responseMatches: [{ value: "a", type: "contains" }],
      responseRedactions: [{ jsonPath: "$.a" }],
      paramValues: { a: "b" },
    };
    const before = Object.keys(params).length;
    assertClaimShape(params, {}, noopLogger);
    assert.equal(Object.keys(params).length, before);
  });

  it("strips secretParams keys outside its own schema", () => {
    const secretParams = {
      cookieStr: "a=b",
      authorisationHeader: "Bearer x",
      headers: { "X-Auth": "y" },
      paramValues: { s: "1" },
      // Not in HttpProviderSecretParameters.
      body: "nope",
    };
    assertClaimShape({ url: "u", method: "GET", responseMatches: [] }, secretParams, noopLogger);
    assert.ok(!("body" in secretParams));
    assert.equal(secretParams.cookieStr, "a=b");
  });

  it("coerces non-string paramValues, which a customInjection can produce", () => {
    // window.Reclaim lets a provider script hand back any JS value; the schema
    // types paramValues as string→string.
    const params = {
      url: "u",
      method: "GET",
      responseMatches: [],
      paramValues: { n: 42, b: true, nul: null, s: "ok" },
    };
    assertClaimShape(params, {}, noopLogger);
    assert.deepEqual(params.paramValues, { n: "42", b: "true", nul: "", s: "ok" });
  });

  it("reports what it stripped rather than doing it silently", () => {
    const errors = [];
    const params = { url: "u", method: "GET", responseMatches: [], bogus: 1 };
    assertClaimShape(params, {}, { error: (m) => errors.push(m), warn() {} });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bogus/);
  });

  it("reports missing required fields", () => {
    const errors = [];
    assertClaimShape({}, {}, { error: (m) => errors.push(m), warn() {} });
    const message = errors.join("\n");
    for (const required of ["url", "method", "responseMatches"]) {
      assert.match(message, new RegExp(required));
    }
  });

  it("tolerates a missing logger", () => {
    assert.doesNotThrow(() => assertClaimShape({ bogus: 1 }, { bogus: 2 }, undefined));
  });
});
