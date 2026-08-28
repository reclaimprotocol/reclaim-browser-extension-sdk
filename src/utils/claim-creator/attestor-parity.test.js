/**
 * Differential test: the vendored extraction code vs. the REAL attestor-core
 * installed in node_modules.
 *
 * ./vendor/attestor-http-utils.js is a hand-maintained copy, so "it matches
 * upstream" has to be checked, not assumed. Where possible this checks it
 * against the actual installed package rather than against expectations copied
 * out of upstream's test file.
 *
 * How it reaches the functions: the extractors aren't exported from the package
 * root until 5.1.0 (PR #92). But the `./external-rpc` subpath is exported, and
 * its `handleIncomingMessage` dispatches `extractHtmlElement` /
 * `extractJSONValueIndex` straight to the same providers/http/utils.ts
 * functions. So we drive the attestor through its own RPC surface and compare.
 *
 * AVAILABILITY: attestor-core's `lib/*.js` used to be esbuild bundles doing
 * *named* imports from `@reclaimprotocol/tls`, which resolves to CommonJS.
 * Node's ESM loader refuses that ("Named export 'asciiToUint8Array' not
 * found"), so on 5.0.5 the package could not be loaded here at all and this
 * file skipped. **5.1.1 ships `lib/` as ESM, so the check actually runs** —
 * which is a large part of why that bump is worth having.
 *
 * The skip path is kept, not deleted: nothing stops a future pin from
 * regressing to the CJS-named-import shape, and a skip with an explicit reason
 * is the honest outcome there. Failing or, worse, silently passing is not.
 *
 * When it is skipped, parity is still covered — by the upstream-derived
 * fixtures in ./attestor-extraction.test.js. This file is the stronger check
 * when it can run; that file is the always-available one.
 *
 * RUN THIS AFTER EVERY MANUAL RE-SYNC of the vendored file, and check whether
 * it reported "skipped" — a skip means the strong check did not run.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { extractHTMLElement, extractJSONValueIndex } from "./vendor/attestor-http-utils.js";

// handleIncomingMessage replies through globalThis[RPC_CHANNEL_NAME].postMessage
const CHANNEL = "reclaim_ext_parity_test";
let lastReply = null;

globalThis.RPC_CHANNEL_NAME = CHANNEL;
globalThis[CHANNEL] = {
  postMessage: (str) => {
    lastReply = JSON.parse(str);
  },
};

let handleIncomingMessage = null;
let unavailableReason = null;

try {
  ({ handleIncomingMessage } = await import("@reclaimprotocol/attestor-core/external-rpc"));
} catch (error) {
  unavailableReason = error?.message?.split("\n")[0] ?? String(error);
}

const attestor = async (type, request) => {
  lastReply = null;
  await handleIncomingMessage({ id: "parity", type, request });
  if (!lastReply) throw new Error(`attestor sent no reply for ${type}`);
  if (lastReply.type === "error") throw new Error(lastReply.data.message);
  return lastReply.response;
};

const NESTED_HTML = `<body>
			  <div id="content123">This is <span>some</span> text!</div>
			  <div id="content456">This is <span>some</span> other text!</div>
			</body>`;

const HTML_WITH_JSON = `<html><head><title>Top Links | Hacker News</title></head><body>
  <script data-component-name="Navbar" type="application/json">{"hasBookface":true,"user":{"name":"providerreclaim","id":16935239}}</script>
</body></html>`;

const NESTED_JSON = `{
    "firstName": "John",
    "address": { "city": "Nara", "postalCode": "630-0192" },
    "phoneNumbers": [ { "type": "iPhone", "number": "0123-4567-8888" } ]
}`;

describe("parity with installed attestor-core", () => {
  if (!handleIncomingMessage) {
    it(
      "SKIPPED — installed attestor-core cannot be loaded under Node, " +
        "so the differential check did not run " +
        `(${unavailableReason}). Parity is covered by attestor-extraction.test.js.`,
      { skip: true },
      () => {},
    );
    return;
  }

  const htmlCases = [
    [NESTED_HTML, "//div[contains(@id, 'content123')]", true],
    [NESTED_HTML, "//div[contains(@id, 'content456')]", false],
    [NESTED_HTML, "//body/div", true],
    [HTML_WITH_JSON, "./html/head/title", true],
    [HTML_WITH_JSON, "//script[@data-component-name='Navbar']", true],
    [HTML_WITH_JSON, "//script[@type='application/json']", false],
  ];

  for (const [html, xpathExpression, contentsOnly] of htmlCases) {
    it(`xPath ${xpathExpression} (contentsOnly=${contentsOnly})`, async () => {
      assert.equal(
        extractHTMLElement(html, xpathExpression, contentsOnly),
        await attestor("extractHtmlElement", { html, xpathExpression, contentsOnly }),
      );
    });
  }

  const jsonCases = [
    [NESTED_JSON, "$.firstName"],
    [NESTED_JSON, "$.address"],
    [NESTED_JSON, "$.address.city"],
    [NESTED_JSON, "$.address.postalCode"],
    [NESTED_JSON, "$.phoneNumbers[0].number"],
    ['{"hasBookface":true,"user":{"name":"providerreclaim","id":16935239}}', "$.user.name"],
  ];

  for (const [json, jsonPath] of jsonCases) {
    it(`jsonPath ${jsonPath}`, async () => {
      const mine = extractJSONValueIndex(json, jsonPath);
      const theirs = await attestor("extractJSONValueIndex", { json, jsonPath });

      // Byte ranges must agree exactly — the range is what the attestor
      // reveals, so an off-by-one produces a claim the attestor rejects.
      assert.deepEqual(mine, theirs);
      assert.equal(json.slice(mine.start, mine.end), json.slice(theirs.start, theirs.end));
    });
  }
});
