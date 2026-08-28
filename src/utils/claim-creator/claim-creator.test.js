/**
 * Tests for the URL / body / naming halves of params-extractor.
 *
 * This file used to be a no-op: it stubbed `test`/`describe`/`expect` when they
 * were undefined and only `require`d the modules under
 * `typeof jest !== 'undefined'`, so with no Jest installed it asserted nothing
 * while still reporting green. The cases below are the same scenarios it
 * described, now actually executed.
 *
 * Response extraction lives in ./attestor-extraction.test.js; parity with the
 * installed attestor lives in ./attestor-parity.test.js.
 *
 * `createClaimObject` itself is not covered here — it needs chrome.* and a live
 * offscreen document for the owner private key, so it belongs in the
 * load-unpacked end-to-end pass, not a unit test.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  extractDynamicParamNames,
  extractParamsFromUrl,
  extractParamsFromBody,
  getHashedParamNames,
  separateParams,
} from "./params-extractor.js";

describe("extractDynamicParamNames", () => {
  it("pulls every placeholder name out of a template", () => {
    assert.deepEqual(extractDynamicParamNames("This is a {{param1}} with {{param2}} values"), [
      "param1",
      "param2",
    ]);
  });

  it("returns an empty array for a template with no placeholders", () => {
    assert.deepEqual(extractDynamicParamNames("nothing here"), []);
    assert.deepEqual(extractDynamicParamNames(""), []);
    assert.deepEqual(extractDynamicParamNames(undefined), []);
  });
});

describe("extractParamsFromUrl", () => {
  it("extracts a path segment", () => {
    assert.deepEqual(
      extractParamsFromUrl(
        "https://example.com/users/{{userId}}/profile",
        "https://example.com/users/12345/profile",
      ),
      { userId: "12345" },
    );
  });

  it("extracts multiple segments", () => {
    assert.deepEqual(
      extractParamsFromUrl(
        "https://example.com/{{org}}/repos/{{repo}}",
        "https://example.com/reclaim/repos/browser-sdk",
      ),
      { org: "reclaim", repo: "browser-sdk" },
    );
  });

  it("returns the accumulator untouched when the URL does not match", () => {
    assert.deepEqual(
      extractParamsFromUrl(
        "https://example.com/users/{{userId}}/profile",
        "https://other.com/nope",
      ),
      {},
    );
  });

  it("no-ops on missing input", () => {
    assert.deepEqual(extractParamsFromUrl("", "https://example.com"), {});
    assert.deepEqual(extractParamsFromUrl("https://example.com/{{a}}", ""), {});
  });
});

describe("extractParamsFromBody", () => {
  it("extracts placeholders from a JSON body template", () => {
    // Also a regression guard on regex flags: the template's literal braces are
    // not escaped by convertTemplateToRegex, which is only valid because
    // makeRegex omits the `u` flag (mirroring the attestor's browser fallback).
    // Adding `u` would make this throw.
    assert.deepEqual(
      extractParamsFromBody(
        '{"username":"{{username}}","password":"{{password}}"}',
        '{"username":"johndoe","password":"secret123"}',
      ),
      { username: "johndoe", password: "secret123" },
    );
  });

  it("no-ops when the body does not match the template", () => {
    assert.deepEqual(extractParamsFromBody('{"username":"{{username}}"}', "totally different"), {});
  });
});

describe("getHashedParamNames", () => {
  it("collects params whose paired redaction is hashed", () => {
    const names = getHashedParamNames(
      [{ value: '"a":"{{plain}}"' }, { value: '"b":"{{hashed}}"' }],
      [{ jsonPath: "$.a" }, { jsonPath: "$.b", hash: "oprf" }],
    );
    assert.deepEqual([...names], ["hashed"]);
  });

  it("returns an empty set when nothing is hashed", () => {
    assert.equal(getHashedParamNames([{ value: "{{a}}" }], [{ jsonPath: "$.a" }]).size, 0);
    assert.equal(getHashedParamNames(null, null).size, 0);
  });
});

describe("separateParams", () => {
  it("routes name-based secrets to secretParams", () => {
    const { publicParams, secretParams } = separateParams({
      SECRET_token: "abc123",
      normalParam: "value123",
    });
    assert.deepEqual(publicParams, { normalParam: "value123" });
    assert.deepEqual(secretParams, { SECRET_token: "abc123" });
  });

  it("still supports an explicit force-secret set", () => {
    // The capability remains, but claim-creator no longer feeds hashed params
    // into it — see the next test for why.
    const { publicParams, secretParams } = separateParams(
      { innocuousName: "sensitive", other: "fine" },
      new Set(["innocuousName"]),
    );
    assert.deepEqual(publicParams, { other: "fine" });
    assert.deepEqual(secretParams, { innocuousName: "sensitive" });
  });

  it("keeps an OPRF-hashed param PUBLIC when no force-set is given", () => {
    // Regression guard. Forcing hash-bearing params into secretParams reads
    // like a privacy win and breaks OPRF two ways:
    //
    //  1. The attestor verifies response matches via
    //     substituteParamValues(rawParams, undefined, true) — secretParams is
    //     UNDEFINED there, and ignoreMissingParams makes an unresolved
    //     placeholder return literally. So `"displayName":"{{displayName}}"`
    //     is matched verbatim against the response and never matches.
    //  2. updateParametersFromOprfData (default true) replaces the raw value
    //     with the OPRF nullifier inside `params` only, so a value parked in
    //     secretParams never gets hashed at all.
    //
    // Privacy for a hashed param comes from that substitution happening
    // client-side before the claim is sent — not from hiding the param.
    // InApp does the same: it splits on the name containing "SECRET", nothing else.
    const { publicParams, secretParams } = separateParams({ displayName: "sajjad" });
    assert.deepEqual(publicParams, { displayName: "sajjad" });
    assert.deepEqual(secretParams, {});
  });
});
