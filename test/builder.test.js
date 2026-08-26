import assert from "node:assert/strict";
import test from "node:test";

import {
  builderRecipeToProviderData,
  createBuilderBridgeClient,
  builderTemplateParameters,
  parseVerificationUrl,
} from "../src/utils/builder.js";
import {
  convertTemplateToRegex,
  effectiveResponseMatches,
} from "../src/utils/claim-creator/network-filter.js";
import {
  extractParamsFromBuilderResponse,
  getBuilderHashedParamNames,
} from "../src/utils/claim-creator/params-extractor.js";

const VC_ID = "550e8400-e29b-41d4-a716-446655440000";

test("selects Builder only for an exact api=2 URL with a sessionId", () => {
  const builder = parseVerificationUrl("https://verify.example.test/?api=2&sessionId=session-1");
  assert.deepEqual(
    { mode: builder.mode, sessionId: builder.sessionId },
    { mode: "builder", sessionId: "session-1" },
  );

  assert.equal(
    parseVerificationUrl("https://verify.example.test/?sessionId=session-1").mode,
    "legacy",
  );
  assert.equal(
    parseVerificationUrl("https://verify.example.test/?api=3&sessionId=session-1").mode,
    "legacy",
  );
  assert.throws(() => parseVerificationUrl("https://verify.example.test/?api=2"), /sessionId/);
});

test("uses only Builder bridge routes and sends the Verification Client header", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/attestor-auth")) {
      const authorization = Buffer.from(
        JSON.stringify({ data: { id: "session-1" }, signature: "AQI=" }),
      ).toString("base64");
      return new Response(authorization, { status: 200 });
    }
    return new Response(JSON.stringify({ session: {}, recipes: [] }), { status: 200 });
  };

  try {
    const client = createBuilderBridgeClient({
      backendUrl: "https://bridge.example.test",
      verificationClientId: VC_ID,
    });
    await client.bootstrap("session/one");
    await client.patchClaimant("session/one", { claimantClientId: "claimant-1" });
    await client.reportEvent("session/one", "verification_client_opened");
    const auth = await client.getAttestorAuth("session/one");
    await client.submitResult("session/one", { status: "error", results: [] });

    assert.deepEqual(auth, {
      data: { id: "session-1" },
      signature: new Uint8Array([1, 2]),
    });
    assert.deepEqual(
      requests.map(({ url, init }) => ({
        path: new URL(url).pathname,
        method: init.method || "GET",
        vcId: init.headers["x-reclaim-vc-id"],
      })),
      [
        {
          path: "/api/sdk/builder/v2/sessions/session%2Fone/bootstrap",
          method: "GET",
          vcId: VC_ID,
        },
        {
          path: "/api/sdk/builder/v2/sessions/session%2Fone/claimant",
          method: "PATCH",
          vcId: VC_ID,
        },
        { path: "/api/sdk/builder/v2/sessions/session%2Fone/events", method: "POST", vcId: VC_ID },
        {
          path: "/api/sdk/builder/v2/sessions/session%2Fone/attestor-auth",
          method: "POST",
          vcId: VC_ID,
        },
        { path: "/api/sdk/builder/v2/sessions/session%2Fone/results", method: "POST", vcId: VC_ID },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapts Builder recipes without inventing request identities", () => {
  const provider = builderRecipeToProviderData(
    {
      providerId: "provider-1",
      resolvedVersion: "1.0.0",
      initialUrl: "https://provider.example.test/login",
      requests: [
        {
          url: "https://provider.example.test/api/items/{{id}}",
          method: "DELETE",
          responseMatches: [{ type: "contains", value: "optional", isOptional: true }],
          responseRedactions: [
            { jsonPath: "$.independent" },
            { regex: "another-independent-selection" },
          ],
        },
      ],
      jsUserScripts: "window.Reclaim.requestClaim({})",
      clientOptions: { extension: { allowInjectionsViaChromeScripting: true } },
    },
    0,
  );

  assert.equal(provider.requestData[0].method, "DELETE");
  assert.equal(provider.requestData[0].urlType, "TEMPLATE");
  assert.equal(provider.requestData[0].builderRequestId, undefined);
  assert.equal(provider.requestData[0].requestHash, "builder:0:0");
  assert.equal(provider.extensionConfig.allowInjectionsViaChromeScripting, true);
  assert.deepEqual(provider.requestData[0].responseRedactions, [
    { jsonPath: "$.independent" },
    { regex: "another-independent-selection" },
  ]);
});

test("substitutes dotted Builder context parameters as literal values", () => {
  const { pattern, allVars } = convertTemplateToRegex(
    "https://provider.example.test/users/{{context.userId}}",
    { "context.userId": "alice.1" },
  );
  const matcher = new RegExp(`^${pattern}$`);

  assert.deepEqual(allVars, ["context.userId"]);
  assert.match("https://provider.example.test/users/alice.1", matcher);
  assert.doesNotMatch("https://provider.example.test/users/aliceX1", matcher);
});

test("fills only missing Builder parameters from session context", () => {
  const parameters = builderTemplateParameters(
    { userId: "explicit", "context.userId": "explicit-context" },
    { userId: "session", sessionOnly: "from-session" },
    {
      requests: [
        {
          url: "https://provider.example.test/{{userId}}/{{sessionOnly}}/{{context.userId}}",
        },
      ],
    },
  );

  assert.deepEqual(parameters, {
    userId: "explicit",
    "context.userId": "explicit-context",
    sessionOnly: "from-session",
    "context.sessionOnly": "from-session",
  });
  const { pattern, unsubstitutedVars } = convertTemplateToRegex(
    "https://provider.example.test/{{userId}}/{{context.userId}}/{{sessionOnly}}",
    parameters,
  );
  assert.deepEqual(unsubstitutedVars, []);
  assert.match(
    "https://provider.example.test/explicit/explicit-context/from-session",
    new RegExp(`^${pattern}$`),
  );
});

test("does not create unused or redundant bare Builder context aliases", () => {
  const parameters = builderTemplateParameters(
    {},
    {
      userId: "session",
      accountId: "account",
      unused: "ignored",
      reclaimSessionId: "session",
      attestationNonce: "tee-only",
    },
    {
      requests: [
        {
          url: "https://provider.example.test/{{userId}}/{{context.accountId}}/{{reclaimSessionId}}/{{attestationNonce}}",
        },
      ],
    },
  );

  assert.equal(parameters.userId, "session");
  assert.equal(parameters.accountId, undefined);
  assert.equal(parameters.unused, undefined);
  assert.equal(parameters.reclaimSessionId, undefined);
  assert.equal(parameters.attestationNonce, undefined);
  assert.equal(parameters["context.accountId"], "account");
});

test("forwards optional response matches only when their expectation is met", () => {
  const matches = [
    { type: "contains", value: "required" },
    { type: "contains", value: "optional", isOptional: true },
    { type: "contains", value: "forbidden", invert: true, isOptional: true },
  ];

  assert.deepEqual(effectiveResponseMatches("required", matches), [matches[0], matches[2]]);
  assert.deepEqual(effectiveResponseMatches("required optional", matches), matches);
  assert.deepEqual(effectiveResponseMatches("required forbidden", matches), [matches[0]]);
});

test("extracts Builder parameters from independent redactions", () => {
  const response = '{"profile":{"email":"alice@example.com"},"id":"user-7"}';
  const matches = [
    { type: "contains", value: '"id":"{{userId}}"' },
    { type: "contains", value: '"email":"{{email}}"' },
  ];
  const redactions = [
    {
      hash: "oprf",
      regex: '"email":"(?<email>[^"]+)"',
    },
    { jsonPath: "$.profile" },
  ];

  assert.deepEqual(extractParamsFromBuilderResponse(response, matches, redactions), {
    email: "alice@example.com",
    userId: "user-7",
  });
  assert.deepEqual([...getBuilderHashedParamNames(redactions)], ["email"]);
});
