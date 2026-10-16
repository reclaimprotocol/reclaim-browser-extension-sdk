/**
 * Parity tests for the vendored attestor extraction code and the redaction
 * chain built on top of it.
 *
 * The fixtures and expectations in "vendored primitives" are lifted from
 * attestor-core's own `src/tests/http-provider-utils.test.ts`. That is the
 * point: this file is the check you re-run after manually re-syncing
 * ./vendor/attestor-http-utils.js from upstream, to prove the copy still agrees
 * with the attestor. If a case here fails, a provider's xPath/jsonPath resolves
 * differently in this extension than it does at the attestor and in the InApp
 * SDK — which is the exact class of bug this code exists to prevent.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  extractHTMLElement,
  extractHTMLElements,
  extractJSONValueIndex,
  extractJSONValueIndexes,
} from "./vendor/attestor-http-utils.js";
import { makeRegex } from "./make-regex.js";
import { resolveRedaction, RedactionResolveError } from "./attestor-extraction.js";
import { extractParamsFromResponse } from "./params-extractor.js";

const NESTED_HTML = `<body>
			  <div id="content123">This is <span>some</span> text!</div>
			  <div id="content456">This is <span>some</span> other text!</div>
			  <div id="content789">This is <span>some</span> irrelevant text!</div>
			</body>`;

const PHONE_JSON = `{
    "firstName": "John",
    "lastName": "doe",
    "age": 26,
    "address": {
        "streetAddress": "naist street",
        "city": "Nara",
        "postalCode": "630-0192"
    },
    "phoneNumbers": [
        {
            "type": "iPhone",
            "number": "0123-4567-8888"
        },
        {
            "type": "home",
            "number": "0123-4567-8910"
        }
    ]
}`;

// An HTML page with an embedded JSON island — the shape that could never work
// before, because the old code treated xPath and jsonPath as mutually exclusive.
const HTML_WITH_JSON = `<html><head><title>Top Links | Hacker News</title></head><body>
  <script data-component-name="Navbar" type="application/json">{"hasBookface":true,"user":{"name":"providerreclaim","id":16935239}}</script>
</body></html>`;

describe("vendored attestor primitives", () => {
  it("extracts inner and outer tag contents", () => {
    assert.equal(
      extractHTMLElement(NESTED_HTML, "//div[contains(@id, 'content123')]", true),
      "This is <span>some</span> text!",
    );
    assert.equal(
      extractHTMLElement(NESTED_HTML, "//div[contains(@id, 'content456')]", false),
      '<div id="content456">This is <span>some</span> other text!</div>',
    );
  });

  it("extracts multiple elements", () => {
    assert.deepEqual(extractHTMLElements(NESTED_HTML, "//body/div", true), [
      "This is <span>some</span> text!",
      "This is <span>some</span> other text!",
      "This is <span>some</span> irrelevant text!",
    ]);
  });

  it("resolves an absolute xpath", () => {
    assert.deepEqual(extractHTMLElements(HTML_WITH_JSON, "./html/head/title", true), [
      "Top Links | Hacker News",
    ]);
  });

  it("extracts multiple jsonPaths as raw slices", () => {
    const indexes = extractJSONValueIndexes(PHONE_JSON, "$.phoneNumbers[*].number");
    const res = indexes.map(({ start, end }) => PHONE_JSON.slice(start, end));
    assert.deepEqual(res, ['"number": "0123-4567-8888"', '"number": "0123-4567-8910"']);
  });

  it("extracts a filter-expression jsonPath", () => {
    const json = `{
    "items":[
        {
            "name": "John Doe",
            "country": "USA"
        },
        {
          "country": "USA",
          "age":25
        }
    ]
}`;
    const val = extractJSONValueIndex(json, "$.items[?(@.name.match(/.*oe/))].name");
    assert.equal(json.slice(val.start, val.end), '"name": "John Doe"');
  });

  it("preserves the raw slice, not a re-serialized value", () => {
    // The whole reason for the byte-range approach: key order and spacing in the
    // response are load-bearing, because the attestor re-asserts the
    // substituted template against the response bytes.
    const val = extractJSONValueIndex(PHONE_JSON, "$.address.postalCode");
    assert.equal(PHONE_JSON.slice(val.start, val.end), '"postalCode": "630-0192"');
  });

  it("throws on a missing xpath rather than returning undefined", () => {
    assert.throws(
      () => extractHTMLElement(NESTED_HTML, "//div[@id='nope']", true),
      /Failed to find XPath/,
    );
  });

  it("does not error on a catastrophic-looking regex", () => {
    // The catastrophic pattern is the INPUT UNDER TEST, not an accident.
    // Upstream evaluates provider regexes with RE2, which cannot backtrack; we
    // use `new RegExp` (webpack aliases re2 to false), which can. This pins
    // what makeRegex does when handed a provider regex of that shape.
    //
    // CodeQL flags it as an inefficient regular expression and Copilot Autofix
    // has once "fixed" it to `^[a-z]+$` — a linear pattern, which makes the
    // test assert nothing at all. Do not simplify it.
    // codeql[js/redos]
    const regexp = makeRegex("([a-z]+)+$");
    // Keep the adversarial non-match bounded: native RegExp backtracking is
    // exponential here, and 31 characters can monopolize newer Node runners
    // for more than a minute without testing any additional behavior.
    assert.equal(regexp.test("a".repeat(16) + "\x00"), false);
  });

  it("uses the attestor's browser flag set", () => {
    assert.equal(makeRegex("x").flags, "gis");
    // `s` is the flag that matters most in practice: provider regexes routinely
    // span newlines in HTML bodies.
    assert.ok(makeRegex("a.b").test("a\nb"));
  });
});

describe("redaction chain", () => {
  it("chains xPath into jsonPath", () => {
    const [slice] = resolveRedaction(HTML_WITH_JSON, {
      xPath: "//script[@data-component-name='Navbar']",
      jsonPath: "$.hasBookface",
    });
    assert.equal(slice.value, '"hasBookface":true');
    // Offsets must be absolute against the full body, not the element.
    assert.equal(HTML_WITH_JSON.slice(slice.start, slice.end), '"hasBookface":true');
  });

  it("chains xPath into jsonPath into regex", () => {
    const [slice] = resolveRedaction(HTML_WITH_JSON, {
      xPath: "//script[@data-component-name='Navbar']",
      jsonPath: "$.user.name",
      regex: '"name":"(.*?)"',
    });
    assert.equal(slice.value, '"name":"providerreclaim"');
    assert.equal(HTML_WITH_JSON.slice(slice.start, slice.end), '"name":"providerreclaim"');
  });

  it("handles jsonPath alone", () => {
    const [slice] = resolveRedaction(PHONE_JSON, { jsonPath: "$.firstName" });
    assert.equal(slice.value, '"firstName": "John"');
  });

  it("handles xPath alone", () => {
    const [slice] = resolveRedaction(NESTED_HTML, {
      xPath: "//div[contains(@id, 'content123')]",
    });
    // contentsOnly is false when there's no jsonPath, matching upstream.
    assert.equal(slice.value, '<div id="content123">This is <span>some</span> text!</div>');
  });

  it("handles regex alone", () => {
    const [slice] = resolveRedaction(PHONE_JSON, { regex: '"city": "(.*?)"' });
    assert.equal(slice.value, '"city": "Nara"');
  });

  it("returns one entry per match for a multi-node path", () => {
    const slices = resolveRedaction(PHONE_JSON, { jsonPath: "$.phoneNumbers[*].number" });
    assert.deepEqual(
      slices.map((s) => s.value),
      ['"number": "0123-4567-8888"', '"number": "0123-4567-8910"'],
    );
  });

  it("narrows a hashed redaction to its capture group", () => {
    const [slice] = resolveRedaction(PHONE_JSON, {
      jsonPath: "$.firstName",
      regex: '"firstName": "(?<who>.*?)"',
      hash: "oprf",
    });
    // Only the group is revealed for a hashed redaction, so only the group can
    // be the param value.
    assert.equal(slice.value, "John");
    assert.equal(PHONE_JSON.slice(slice.start, slice.end), "John");
  });

  it("rejects a hashed redaction with more than one group", () => {
    assert.throws(
      () =>
        resolveRedaction(PHONE_JSON, {
          regex: '"firstName": "(?<a>.*?)"(?<b>.*?)$',
          hash: "oprf",
        }),
      /Exactly one named capture group/,
    );
  });

  it("raises a retryable error when a path is absent", () => {
    assert.throws(
      () => resolveRedaction(PHONE_JSON, { jsonPath: "$.notThere" }),
      (err) => err instanceof RedactionResolveError && err.retryable === true,
    );
  });

  it("raises a retryable error when a regex does not match", () => {
    assert.throws(
      () => resolveRedaction(PHONE_JSON, { regex: "nothing-like-this" }),
      (err) => err instanceof RedactionResolveError && err.retryable === true,
    );
  });

  it("attributes the failure to the stage that gave up", () => {
    // The caller reports X_PATH_/JSON_PATH_/REGEX_MATCH_REQUIREMENT_FAILED off
    // this field. Without it every failure looked the same, so "this provider's
    // regex broke" was indistinguishable from "its jsonPath broke".
    const cases = [
      [{ jsonPath: "$.notThere" }, "jsonPath"],
      [{ regex: "nothing-like-this" }, "regex"],
      [{ xPath: "//div[@id='nope']" }, "xPath"],
    ];
    for (const [redaction, expected] of cases) {
      assert.throws(
        () => resolveRedaction(PHONE_JSON, redaction),
        (err) => err.stage === expected,
        JSON.stringify(redaction),
      );
    }
  });

  it("keeps response content out of the error message", () => {
    // The message becomes a logLine and is POSTed to the diagnostic endpoint.
    // It used to interpolate up to 200 chars of the user's authenticated page.
    const secret = "SUPER_PRIVATE_ACCOUNT_VALUE";
    assert.throws(
      () => resolveRedaction(`{"account":"${secret}"}`, { regex: "nothing-like-this" }),
      (err) => {
        assert.ok(!err.message.includes(secret), `message leaked content: ${err.message}`);
        // Still reachable for the console, via the payload path.
        assert.ok(err.element.includes(secret));
        return true;
      },
    );
  });

  it("requires at least one of xPath/jsonPath/regex", () => {
    assert.throws(
      () => resolveRedaction(PHONE_JSON, {}),
      /Expected either xPath, jsonPath or regex/,
    );
  });
});

describe("param extraction", () => {
  it("derives a value from the raw slice via a contains template", () => {
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: '"firstName": "{{who}}"', type: "contains" }],
      [{ jsonPath: "$.firstName" }],
    );
    assert.deepEqual(params, { who: "John" });
  });

  it("derives a value via a regex-type template", () => {
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: '"city":\\s*"{{city}}"', type: "regex" }],
      [{ jsonPath: "$.address.city" }],
    );
    assert.deepEqual(params, { city: "Nara" });
  });

  it("extracts through an xPath+jsonPath chain", () => {
    const params = extractParamsFromResponse(
      HTML_WITH_JSON,
      [{ value: '"name":"{{username}}"', type: "contains" }],
      [{ xPath: "//script[@data-component-name='Navbar']", jsonPath: "$.user.name" }],
    );
    assert.deepEqual(params, { username: "providerreclaim" });
  });

  it("does not JSON.stringify an object value", () => {
    // The old implementation returned JSON.stringify(parsedObject) here, whose
    // spacing differs from the response bytes, so the attestor's re-assertion
    // of the substituted template failed.
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: '"address": {{addr}}', type: "contains" }],
      [{ jsonPath: "$.address" }],
    );
    assert.ok(PHONE_JSON.includes(`"address": ${params.addr}`));
  });

  it("takes the hashed group as the value", () => {
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: "{{secretName}}", type: "contains" }],
      [{ jsonPath: "$.firstName", regex: '"firstName": "(?<who>.*?)"', hash: "oprf" }],
    );
    assert.deepEqual(params, { secretName: "John" });
  });

  it("throws retryably when an unknown param cannot be resolved", () => {
    assert.throws(
      () =>
        extractParamsFromResponse(
          PHONE_JSON,
          [{ value: '"missing": "{{nope}}"', type: "contains" }],
          [{ jsonPath: "$.missing" }],
        ),
      (err) => err.retryable === true,
    );
  });

  it("tolerates an unresolvable redaction for an already-known param", () => {
    // Custom injections supply values the declared templates can't express;
    // those must survive a redaction that doesn't resolve.
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: '"missing": "{{nope}}"', type: "contains" }],
      [{ jsonPath: "$.missing" }],
      { nope: "from-injection" },
    );
    assert.deepEqual(params, { nope: "from-injection" });
  });

  it("ignores responseMatches with no placeholders", () => {
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: '"lastName": "doe"', type: "contains" }],
      [{ jsonPath: "$.lastName" }],
    );
    assert.deepEqual(params, {});
  });

  it("falls back to positional groups for names that can't be capture groups", () => {
    // `user-id` is not a valid JS identifier, so `(?<user-id>...)` is a regex
    // syntax error. Those params must still be extracted, mapped by the order
    // their placeholders appear in.
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [
        {
          value: '"type": "{{2fa-kind}}",\n            "number": "{{phone-no}}"',
          type: "contains",
        },
      ],
      [{ jsonPath: "$.phoneNumbers[0]" }],
    );
    assert.deepEqual(params, { "2fa-kind": "iPhone", "phone-no": "0123-4567-8888" });
  });

  it("extracts multiple params from one template", () => {
    const params = extractParamsFromResponse(
      PHONE_JSON,
      [{ value: '"type": "{{kind}}",\n            "number": "{{num}}"', type: "contains" }],
      [{ jsonPath: "$.phoneNumbers[0]" }],
    );
    assert.deepEqual(params, { kind: "iPhone", num: "0123-4567-8888" });
  });
});
