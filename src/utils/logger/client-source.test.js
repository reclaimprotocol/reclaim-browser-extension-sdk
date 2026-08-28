/**
 * The client source string is a wire contract in two directions: the
 * `reclaim-api-client` header the backends read, and the `source` field the
 * logs pipeline groups by. The team's rule for identifying which SDK produced a
 * session is a substring check for `browser-extension-sdk`, so these tests
 * pin the grammar and, above all, that no code path can produce a string
 * missing that marker.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  SDK_NAME,
  CLIENT_SOURCE_HEADER,
  buildClientSource,
  getClientSource,
  resetClientSourceCache,
  withClientSource,
} from "./client-source.js";

describe("buildClientSource", () => {
  it("mirrors the InApp grammar", () => {
    assert.equal(
      buildClientSource({
        sdkVersion: "0.4.2",
        platform: "chrome/141",
        consumer: "ldbfjimhpnpkeanmnfkkbdhllcmjjhpp/v1.0.0",
      }),
      "browser-extension-sdk sdk/v0.4.2 (chrome/141,ldbfjimhpnpkeanmnfkkbdhllcmjjhpp/v1.0.0)",
    );
  });

  it("reports web-page mode as (…,web) rather than inventing a consumer", () => {
    const source = buildClientSource({
      sdkVersion: "0.4.2",
      platform: "firefox/128",
      consumer: "web",
    });
    assert.equal(source, "browser-extension-sdk sdk/v0.4.2 (firefox/128,web)");
  });

  it("strips separators out of tokens so the string stays parseable", () => {
    // A manifest name or brand containing spaces, commas or parens would
    // otherwise produce a string that cannot be split back apart.
    const source = buildClientSource({
      sdkVersion: "1.0.0-beta 1",
      platform: "Some Browser (Beta)/1",
      consumer: "my ext, inc/v2",
    });
    assert.equal(source.match(/\(/g).length, 1, "exactly one opening paren");
    assert.equal(source.match(/,/g).length, 1, "exactly one comma separator");
    assert.ok(!/\s\)/.test(source));
  });

  it("substitutes a placeholder for empty tokens instead of collapsing", () => {
    const source = buildClientSource({ sdkVersion: "1.0.0", platform: "", consumer: "" });
    assert.equal(source, "browser-extension-sdk sdk/v1.0.0 (unknown,unknown)");
  });
});

describe("getClientSource", () => {
  it("always contains the SDK marker the team's check looks for", () => {
    resetClientSourceCache();
    const source = getClientSource();
    assert.ok(
      source.includes("browser-extension-sdk"),
      `expected the marker in ${JSON.stringify(source)}`,
    );
    assert.equal(SDK_NAME, "browser-extension-sdk");
  });

  it("is memoized", () => {
    resetClientSourceCache();
    assert.equal(getClientSource(), getClientSource());
  });

  it("survives a hostile environment without throwing", () => {
    // A page can replace navigator getters. Identification must degrade, never
    // break the request it is attached to.
    resetClientSourceCache();
    const original = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, "navigator", {
        get() {
          throw new Error("nope");
        },
        configurable: true,
      });
      const source = getClientSource();
      assert.ok(source.includes("browser-extension-sdk"));
    } finally {
      if (original === undefined) {
        delete globalThis.navigator;
      } else {
        Object.defineProperty(globalThis, "navigator", {
          value: original,
          configurable: true,
          writable: true,
        });
      }
      resetClientSourceCache();
    }
  });
});

describe("withClientSource", () => {
  it("adds the header InApp and Verifier already send", () => {
    assert.equal(CLIENT_SOURCE_HEADER, "reclaim-api-client");
    const headers = withClientSource({ "Content-Type": "application/json" });
    assert.equal(headers["Content-Type"], "application/json");
    assert.ok(headers["reclaim-api-client"].includes("browser-extension-sdk"));
  });

  it("works with no argument", () => {
    assert.ok(withClientSource()["reclaim-api-client"]);
  });
});
