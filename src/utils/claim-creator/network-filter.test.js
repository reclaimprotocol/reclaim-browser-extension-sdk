/**
 * The URL half of the content-script gate.
 *
 * This gate decides whether a request is ever forwarded to the background, so a
 * miss here is not a degraded claim — it is no claim at all. Nothing downstream
 * logs, because nothing downstream runs: the session simply dies on the timer
 * with "request intercepted" as its last word. That happened for real with a
 * provider whose `urlType` was the upstream default, `CONSTANT`, which this gate
 * did not recognise and therefore never matched.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { filterRequest, describeRequestMatch, MATCH_STAGES } from "./network-filter.js";

const RESPONSE = '{"user":{"name":"sajjad"}}';

/** Minimal shape filterRequest expects for a GET whose response we don't gate on. */
function request(url, overrides = {}) {
  return { url, method: "GET", responseText: RESPONSE, ...overrides };
}

function criteria(overrides = {}) {
  return {
    url: "https://etherscan.io/myaccount",
    method: "GET",
    responseMatches: [],
    responseRedactions: [],
    ...overrides,
  };
}

describe("url matching by urlType", () => {
  it("matches the upstream default, CONSTANT", () => {
    // Regression guard. The upstream enum is REGEX | CONSTANT | TEMPLATE, and
    // InApp infers CONSTANT for any url without "{{" — so this is the value most
    // providers carry. The gate used to fall through to `return false`.
    assert.equal(
      filterRequest(request("https://etherscan.io/myaccount"), criteria({ urlType: "CONSTANT" })),
      true,
    );
  });

  it("still honours EXACT, this SDK's local alias", () => {
    // Not in the upstream enum, but the background writes it on synthetic
    // requests and it has always meant equality here.
    assert.equal(
      filterRequest(request("https://etherscan.io/myaccount"), criteria({ urlType: "EXACT" })),
      true,
    );
  });

  it("does not match a different url under CONSTANT", () => {
    assert.equal(
      filterRequest(
        request("https://etherscan.io/somewhere-else"),
        criteria({ urlType: "CONSTANT" }),
      ),
      false,
    );
  });

  it("expands placeholders under TEMPLATE", () => {
    assert.equal(
      filterRequest(
        request("https://etherscan.io/users/12345/profile"),
        criteria({ url: "https://etherscan.io/users/{{userId}}/profile", urlType: "TEMPLATE" }),
      ),
      true,
    );
  });

  it("infers rather than refusing when urlType is absent or unknown", () => {
    // Guessing wrong costs one non-matching request; refusing to match costs the
    // entire verification. So an unknown value is inferred from the url.
    for (const urlType of [undefined, null, "", "SOMETHING_NEW"]) {
      assert.equal(
        filterRequest(request("https://etherscan.io/myaccount"), criteria({ urlType })),
        true,
        `plain url with urlType=${JSON.stringify(urlType)}`,
      );
      assert.equal(
        filterRequest(
          request("https://etherscan.io/users/12345/profile"),
          criteria({ url: "https://etherscan.io/users/{{userId}}/profile", urlType }),
        ),
        true,
        `templated url with urlType=${JSON.stringify(urlType)}`,
      );
    }
  });

  it("still requires the method to agree", () => {
    assert.equal(
      filterRequest(
        request("https://etherscan.io/myaccount", { method: "POST" }),
        criteria({ urlType: "CONSTANT" }),
      ),
      false,
    );
  });
});

describe("why a request was rejected", () => {
  // A rejected candidate is otherwise completely silent: everything that logs
  // about extraction runs only after a match, so a stale bodySniff template and
  // "the user never logged in" produce identical sessions. The stage is the
  // only thing that separates them.

  it("names the check that stopped it", () => {
    const cases = [
      [
        "url",
        request("https://etherscan.io/somewhere-else"),
        criteria({ urlType: "CONSTANT" }),
        MATCH_STAGES.URL,
      ],
      [
        "method",
        request("https://etherscan.io/myaccount", { method: "POST" }),
        criteria({ urlType: "CONSTANT" }),
        MATCH_STAGES.METHOD,
      ],
      [
        "body",
        request("https://etherscan.io/myaccount", { method: "POST", body: '{"page":2}' }),
        criteria({
          method: "POST",
          urlType: "CONSTANT",
          bodySniff: { enabled: true, template: '{"page":1}' },
        }),
        MATCH_STAGES.BODY,
      ],
      [
        "responseMissing",
        request("https://etherscan.io/myaccount", { responseText: "" }),
        criteria({ urlType: "CONSTANT", responseMatches: [{ value: "sajjad", type: "contains" }] }),
        MATCH_STAGES.RESPONSE_MISSING,
      ],
      [
        "responseMatch",
        request("https://etherscan.io/myaccount"),
        criteria({ urlType: "CONSTANT", responseMatches: [{ value: "nobody", type: "contains" }] }),
        MATCH_STAGES.RESPONSE_MATCH,
      ],
      [
        "responseRedaction",
        request("https://etherscan.io/myaccount"),
        criteria({ urlType: "CONSTANT", responseRedactions: [{ jsonPath: "$.user.missing" }] }),
        MATCH_STAGES.RESPONSE_REDACTION,
      ],
    ];

    for (const [label, req, crit, expected] of cases) {
      const verdict = describeRequestMatch(req, crit, {});
      assert.equal(verdict.matched, false, `${label} should not match`);
      assert.equal(verdict.stage, expected, `${label} stage`);
      assert.ok(verdict.detail, `${label} must carry a reason`);
    }
  });

  it("reports MATCHED when everything passes", () => {
    const verdict = describeRequestMatch(
      request("https://etherscan.io/myaccount"),
      criteria({ urlType: "CONSTANT", responseMatches: [{ value: "sajjad", type: "contains" }] }),
      {},
    );
    assert.deepEqual(verdict, { matched: true, stage: MATCH_STAGES.MATCHED });
  });

  it("keeps request and response bodies out of the reason", () => {
    // `detail` becomes a log line, and log lines are never redacted — only the
    // structured payload is. A body echoed here would reach Loki verbatim on
    // every near miss, which is exactly how RedactionResolveError once leaked
    // the user's authenticated page.
    const secretBody = '{"accountNumber":"1234567890"}';
    const secretResponse = '{"user":{"name":"topsecretuser"}}';

    const bodyVerdict = describeRequestMatch(
      request("https://etherscan.io/myaccount", { method: "POST", body: secretBody }),
      criteria({
        method: "POST",
        urlType: "CONSTANT",
        bodySniff: { enabled: true, template: '{"page":1}' },
      }),
      {},
    );
    assert.ok(!bodyVerdict.detail.includes("1234567890"), "request body leaked into the reason");
    assert.ok(bodyVerdict.detail.includes("chars"), "sizes are the substitute");

    const responseVerdict = describeRequestMatch(
      request("https://etherscan.io/myaccount", { responseText: secretResponse }),
      criteria({ urlType: "CONSTANT", responseMatches: [{ value: "nobody", type: "contains" }] }),
      {},
    );
    assert.ok(
      !responseVerdict.detail.includes("topsecretuser"),
      "response body leaked into the reason",
    );
    // The provider-authored pattern is what makes the line actionable, and is
    // config rather than user data.
    assert.ok(responseVerdict.detail.includes("nobody"));
  });

  it("does not treat a missing response as fatal when nothing gates on it", () => {
    // Regression guard: `needsResponse` has to stay equivalent to the two
    // separate `if (!responseText) return false` checks it replaced, or every
    // request with no response body would stop matching.
    const verdict = describeRequestMatch(
      request("https://etherscan.io/myaccount", { responseText: "" }),
      criteria({ urlType: "CONSTANT" }),
      {},
    );
    assert.equal(verdict.matched, true);
  });
});

describe("Builder response-match optionality", () => {
  it("skips an unsatisfied optional match only in Builder mode", () => {
    const optional = { value: "optional", type: "contains", isOptional: true };
    const req = request("https://etherscan.io/myaccount", { responseText: "required" });

    assert.equal(
      describeRequestMatch(req, criteria({ responseMatches: [optional], builderMode: true }), {})
        .matched,
      true,
    );
    assert.equal(
      describeRequestMatch(req, criteria({ responseMatches: [optional] }), {}).matched,
      false,
    );
  });
});
