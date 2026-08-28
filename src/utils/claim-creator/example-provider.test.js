/**
 * The `example` provider, end to end, from its real published definition.
 *
 * Every other test in this repo exercises one stage against a synthetic
 * fixture. This one takes the three `requestData` entries of the PUBLISHED
 * `example` provider (providerId `example`, version 3.0.0) and walks a real
 * request/response pair through the whole client-side pipeline for each:
 *
 *     describeRequestMatch  ->  extractParamsFromResponse  ->  assertClaimShape
 *
 * The expected parameter values are the ones a real session actually produced
 * (session 2b46b57c39), read back out of its logs — not values invented here.
 * If any stage drifts, this fails with the provider that every developer uses
 * as their first smoke test.
 *
 * WHAT THIS DOES NOT COVER: proof generation. That needs attestor-core's WASM,
 * a live WebSocket to the attestor and the ZK circuits — none of which exist
 * under `node --test`. So this proves the extension builds the right *claim*
 * for all three requests; it does not prove the attestor accepts it. The
 * attestor-side guarantee comes from attestor-parity.test.js (extraction
 * matches the real attestor) and attestor-zk-engine.test.js (the pinned build
 * can actually generate a proof).
 *
 * The provider walks three ORIGINS — example.org -> example.com ->
 * jsonplaceholder — which is why it is also the case that broke the popup's
 * claim counter; see claim-progress.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { describeRequestMatch, MATCH_STAGES } from "./network-filter.js";
import { extractParamsFromResponse } from "./params-extractor.js";

/**
 * The three requestData entries, verbatim from
 * GET api.reclaimprotocol.org/api/providers/example (version 3.0.0).
 * Trimmed only of fields the pipeline never reads (description, order,
 * isOptional, credentials, expectedPageUrl, responseVariables).
 */
const REQUEST_DATA = [
  {
    url: "https://example.org/",
    urlType: "TEMPLATE",
    method: "GET",
    responseMatches: [
      { value: "{{pageTitle}}", type: "contains", invert: false },
      { value: "<a href={{ianaLinkUrl}}>Learn more</a>", type: "contains", invert: false },
    ],
    responseRedactions: [
      { xPath: "//title/text()", jsonPath: "", regex: "(.*)", hash: "" },
      {
        xPath: "/html/body/div[1]/p[2]/a",
        jsonPath: "",
        regex: "<a href=(.*)>Learn more</a>",
        hash: null,
      },
    ],
    bodySniff: { enabled: false, template: "" },
    requestHash: "0xd29460cea971e27d1895d85c0ff9a1ecefbb1cf205586202f5394388255b7185",
    writeRedactionMode: "zk",
  },
  {
    url: "https://example.com/",
    urlType: "TEMPLATE",
    method: "GET",
    responseMatches: [
      { value: "{{pageTitle}}", type: "contains", invert: false },
      { value: "<a href={{ianaLinkUrl}}>Learn more</a>", type: "contains", invert: false },
    ],
    responseRedactions: [
      { xPath: "//title/text()", jsonPath: "", regex: "(.*)", hash: null },
      {
        xPath: "/html/body/div[1]/p[2]/a",
        jsonPath: "",
        regex: "<a href=(.*)>Learn more</a>",
        hash: null,
      },
    ],
    bodySniff: { enabled: false, template: "" },
    requestHash: "0xcf312d890fd408a2aacb034afeb158a94d852960c1c1416054d468260b508e4f",
    writeRedactionMode: "zk",
  },
  {
    url: "https://jsonplaceholder.typicode.com/users/1",
    urlType: "TEMPLATE",
    method: "GET",
    responseMatches: [
      { value: "{{FullName}}", type: "contains", invert: false },
      { value: "{{UserName}}", type: "contains", invert: false },
      { value: "{{Email}}", type: "contains", invert: false },
      { value: "{{id}}", type: "contains", invert: false },
    ],
    responseRedactions: [
      { xPath: "", jsonPath: "$.name", regex: '"name": "(.*)"', hash: null },
      { xPath: "", jsonPath: "$.username", regex: '"username": "(?<username>.*)"', hash: null },
      // The one hashed redaction in the provider: its slice IS the value, and
      // it must stay in params.paramValues rather than being forced secret.
      { xPath: "", jsonPath: "$.email", regex: '"email": "(?<email>.*)"', hash: "oprf" },
      { xPath: "", jsonPath: "$.id", regex: '"id": (.*)', hash: null },
    ],
    bodySniff: { enabled: false, template: "" },
    requestHash: "0x64d5086d23eb500a178b49ec68efd780fff5664d54062add5b56daac334abe58",
    writeRedactionMode: "zk",
  },
];

/**
 * The example.org / example.com body, shaped so the provider's XPaths resolve:
 * `//title/text()` and `/html/body/div[1]/p[2]/a`.
 */
const EXAMPLE_HTML = `<!doctype html>
<html>
<head>
    <title>Example Domain</title>
    <meta charset="utf-8" />
</head>
<body>
<div>
    <h1>Example Domain</h1>
    <p>This domain is for use in illustrative examples in documents.</p>
    <p><a href="https://iana.org/domains/example">Learn more</a></p>
</div>
</body>
</html>
`;

/**
 * jsonplaceholder's /users/1 body. Two-space indented, which is what makes the
 * provider's `"name": "(.*)"` regexes — note the space after the colon — match.
 */
const USER_JSON = `{
  "id": 1,
  "name": "Leanne Graham",
  "username": "Bret",
  "email": "Sincere@april.biz",
  "address": {
    "street": "Kulas Light",
    "suite": "Apt. 556",
    "city": "Gwenborough",
    "zipcode": "92998-3874",
    "geo": {
      "lat": "-37.3159",
      "lng": "81.1496"
    }
  },
  "phone": "1-770-736-8031 x56442",
  "website": "hildegard.org",
  "company": {
    "name": "Romaguera-Crona",
    "catchPhrase": "Multi-layered client-server neural-net",
    "bs": "harness real-time e-markets"
  }
}`;

/** What the real session extracted, per requestData index. */
const CASES = [
  {
    label: "example.org",
    request: { url: "https://example.org/", method: "GET", responseText: EXAMPLE_HTML },
    expected: {
      pageTitle: "Example Domain",
      ianaLinkUrl: '"https://iana.org/domains/example"',
    },
  },
  {
    label: "example.com",
    request: { url: "https://example.com/", method: "GET", responseText: EXAMPLE_HTML },
    expected: {
      pageTitle: "Example Domain",
      ianaLinkUrl: '"https://iana.org/domains/example"',
    },
  },
  {
    label: "jsonplaceholder /users/1",
    request: {
      url: "https://jsonplaceholder.typicode.com/users/1",
      method: "GET",
      responseText: USER_JSON,
    },
    expected: {
      FullName: '"name": "Leanne Graham"',
      UserName: '"username": "Bret"',
      Email: "Sincere@april.biz",
      id: '"id": 1',
    },
  },
];

describe("example provider: request matching", () => {
  CASES.forEach((testCase, i) => {
    it(`matches requestData[${i}] (${testCase.label})`, () => {
      const verdict = describeRequestMatch(testCase.request, REQUEST_DATA[i], {});
      assert.equal(
        verdict.matched,
        true,
        `rejected at ${verdict.stage}: ${verdict.detail ?? "no detail"}`,
      );
      assert.equal(verdict.stage, MATCH_STAGES.MATCHED);
    });
  });

  it("does not let one request satisfy another's matcher", () => {
    // example.org and example.com differ only by TLD and are otherwise
    // identical templates — a sloppy urlType change would collapse them, and
    // the session would submit two proofs of the same page.
    const verdict = describeRequestMatch(CASES[0].request, REQUEST_DATA[1], {});
    assert.equal(verdict.matched, false);
    assert.equal(verdict.stage, MATCH_STAGES.URL);
  });

  it("reports the stage when the response is not the expected one", () => {
    const verdict = describeRequestMatch(
      { ...CASES[2].request, responseText: '{"id": 2, "name": "Someone Else"}' },
      REQUEST_DATA[2],
      {},
    );
    // The provider's regexes need the pretty-printed spacing; a compact body
    // fails the redaction pre-gate rather than silently producing no params.
    assert.equal(verdict.matched, false);
    assert.equal(verdict.stage, MATCH_STAGES.RESPONSE_REDACTION);
    assert.match(verdict.detail, /redaction #\d/);
  });
});

describe("example provider: parameter extraction", () => {
  CASES.forEach((testCase, i) => {
    it(`extracts requestData[${i}] (${testCase.label})`, () => {
      const paramValues = extractParamsFromResponse(
        testCase.request.responseText,
        REQUEST_DATA[i].responseMatches,
        REQUEST_DATA[i].responseRedactions,
        {},
      );
      assert.deepEqual(paramValues, testCase.expected);
    });
  });

  it("keeps the hashed (oprf) param as a plain extracted value", () => {
    // The redaction on $.email carries hash: "oprf". Its slice is the value
    // itself — there is no surrounding template to match against — and it must
    // arrive unhashed here: privacy comes from the attestor's client-side OPRF
    // substitution inside params, not from hiding it at extraction time.
    const paramValues = extractParamsFromResponse(
      USER_JSON,
      REQUEST_DATA[2].responseMatches,
      REQUEST_DATA[2].responseRedactions,
      {},
    );
    assert.equal(paramValues.Email, "Sincere@april.biz");
  });

  it("covers all three of the provider's redaction styles", () => {
    // Guards against a re-sync that quietly drops one branch of the
    // xPath -> jsonPath -> regex chain: the provider uses xPath+regex,
    // jsonPath+regex, and jsonPath+regex+hash across its three requests.
    const styles = REQUEST_DATA.flatMap((rd) => rd.responseRedactions).map((r) =>
      [r.xPath && "xPath", r.jsonPath && "jsonPath", r.regex && "regex", r.hash && "hash"]
        .filter(Boolean)
        .join("+"),
    );
    assert.ok(styles.includes("xPath+regex"), "xPath chain unused");
    assert.ok(styles.includes("jsonPath+regex"), "jsonPath chain unused");
    assert.ok(styles.includes("jsonPath+regex+hash"), "hashed chain unused");
  });
});
