import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILDER_BACKEND_URL,
  builderExtractedParameterValues,
  builderProviderParameters,
  builderRecipeToProviderData,
  createBuilderBridgeClient,
  builderTemplateParameters,
  interpolateBuilderHeaders,
  interpolateBuilderTemplate,
  mergeBuilderParameterSources,
  normalizeVerificationClientId,
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

test("canonicalizes Verification Client UUIDs for Builder API headers and payloads", () => {
  assert.equal(normalizeVerificationClientId(VC_ID.toUpperCase()), VC_ID);
  assert.throws(() => normalizeVerificationClientId("not-a-uuid"), /verificationClientId/);
});

test("Builder session parameters outrank captures, while requestClaim values win", () => {
  assert.deepEqual(
    mergeBuilderParameterSources({
      url: { accountId: "from-url", urlOnly: "url" },
      body: { accountId: "from-body", bodyOnly: "body" },
      response: { accountId: "from-response", responseOnly: "response" },
      template: { accountId: "from-session", sessionOnly: "session" },
      extracted: { accountId: "from-request-claim", requestOnly: "request" },
    }),
    {
      accountId: "from-request-claim",
      urlOnly: "url",
      bodyOnly: "body",
      responseOnly: "response",
      sessionOnly: "session",
      requestOnly: "request",
    },
  );
});

test("Builder explicit parameters persist when transitioning to another provider", () => {
  const explicit = { accountId: "session-account" };
  const first = builderProviderParameters(
    explicit,
    {},
    { accountId: "context-account" },
    { requests: [{ url: "https://one.test/{{accountId}}" }] },
  );
  const second = builderProviderParameters(
    undefined,
    explicit,
    { accountId: "context-account" },
    { requests: [{ url: "https://two.test/{{accountId}}" }] },
  );

  assert.equal(first.accountId, "session-account");
  assert.equal(second.accountId, "session-account");
});

test("Builder proofs always expose extracted parameter values", () => {
  assert.deepEqual(
    builderExtractedParameterValues({
      claim: { context: JSON.stringify({ extractedParameters: { accountId: "account-7" } }) },
    }),
    { accountId: "account-7" },
  );
  assert.deepEqual(
    builderExtractedParameterValues({
      claim: { context: { extractedParameters: { accountId: "account-8" } } },
    }),
    { accountId: "account-8" },
  );
  assert.deepEqual(builderExtractedParameterValues({ claim: {} }), {});
});

test("interpolates static Builder header values with final parameter precedence", () => {
  assert.deepEqual(
    interpolateBuilderHeaders(
      {
        Authorization: "Bearer {{token}}",
        "x-api-key": "{{SECRET_apiKey}}",
        "x-unresolved": "{{missing}}",
      },
      {
        token: "session-token",
        SECRET_apiKey: "request-api-key",
      },
    ),
    {
      Authorization: "Bearer session-token",
      "x-api-key": "request-api-key",
      "x-unresolved": "{{missing}}",
    },
  );
});

test("interpolates Builder scalar fields while leaving unknown placeholders intact", () => {
  assert.equal(
    interpolateBuilderTemplate("region={{context.region}}/{{missing}}", {
      "context.region": "eu-west-1",
    }),
    "region=eu-west-1/{{missing}}",
  );
});

test("Builder merge helper retains legacy capture precedence without explicit values", () => {
  assert.deepEqual(
    mergeBuilderParameterSources({
      url: { id: "url" },
      body: { id: "body" },
      response: { id: "response" },
      extracted: { id: "request-claim" },
    }),
    { id: "request-claim" },
  );
});

test("selects Builder only for an exact api=2 URL with a sessionId", () => {
  const builder = parseVerificationUrl(
    "https://verify.example.test/?api=2&sessionId=session-1&diag=1",
  );
  assert.deepEqual(
    {
      mode: builder.mode,
      sessionId: builder.sessionId,
      diagnosticMode: builder.diagnosticMode,
    },
    { mode: "builder", sessionId: "session-1", diagnosticMode: true },
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

test("uses direct Builder verification routes and sends the Verification Client header", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const request = url instanceof Request ? url : new Request(url, init);
    requests.push(request);
    if (request.url.endsWith("/attestor-auth")) {
      const authorization = Buffer.from(
        JSON.stringify({ data: { id: "session-1" }, signature: "AQI=" }),
      ).toString("base64");
      return new Response(authorization, { status: 200 });
    }
    return new Response(JSON.stringify({ session: {}, recipes: [] }), { status: 200 });
  };

  try {
    const client = createBuilderBridgeClient({
      backendUrl: "https://builder.example.test",
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
      requests.map((request) => ({
        path: new URL(request.url).pathname,
        method: request.method,
        vcId: request.headers.get("x-reclaim-vc-id"),
      })),
      [
        {
          path: "/verifications/sessions/session%2Fone/bootstrap",
          method: "GET",
          vcId: VC_ID,
        },
        {
          path: "/verifications/sessions/session%2Fone/claimant",
          method: "PATCH",
          vcId: VC_ID,
        },
        { path: "/verifications/sessions/session%2Fone/events", method: "POST", vcId: VC_ID },
        {
          path: "/verifications/sessions/session%2Fone/attestor-auth",
          method: "POST",
          vcId: VC_ID,
        },
        { path: "/verifications/sessions/session%2Fone/results", method: "POST", vcId: VC_ID },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("defaults Builder transport to the Builder origin", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(new Request(url, init));
    return new Response(JSON.stringify({ session: {}, recipes: [] }), { status: 200 });
  };

  try {
    const client = createBuilderBridgeClient({ verificationClientId: VC_ID });
    await client.bootstrap("session-1");
    assert.equal(new URL(requests[0].url).origin, BUILDER_BACKEND_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects the legacy API as a Builder transport", () => {
  assert.throws(
    () =>
      createBuilderBridgeClient({
        backendUrl: "https://api.reclaimprotocol.org",
        verificationClientId: VC_ID,
      }),
    /cannot use the legacy Reclaim API/,
  );
});

test("preserves unauthenticated Builder proof creation when attestor auth is not configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, { status: 200, headers: { "Content-Length": "0" } });

  try {
    const client = createBuilderBridgeClient({
      backendUrl: "https://builder.example.test",
      verificationClientId: VC_ID,
    });

    assert.equal(await client.getAttestorAuth("session-1"), null);
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
          headers: {
            "x-api-key": "{{context.SECRET_apiKey}}",
            "x-client": "reclaim-extension",
          },
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
  assert.deepEqual(provider.requestData[0].headers, {
    "x-api-key": "{{context.SECRET_apiKey}}",
    "x-client": "reclaim-extension",
  });
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

test("selects the highest-priority context alias requested by a recipe", () => {
  const context = { accountId: "account-7" };

  assert.deepEqual(
    builderTemplateParameters({}, context, {
      requests: [
        { url: "https://x.test/{{context.accountId}}/{{context_accountId}}/{{accountId}}" },
      ],
    }),
    {
      "context.accountId": "account-7",
    },
  );
  assert.deepEqual(
    builderTemplateParameters({}, context, {
      requests: [{ headers: { "x-account": "{{context_accountId}}/{{accountId}}" } }],
    }),
    {
      context_accountId: "account-7",
    },
  );
  assert.deepEqual(
    builderTemplateParameters({}, context, {
      requests: [{ responseRedactions: [{ regex: "{{accountId}}" }] }],
    }),
    {
      accountId: "account-7",
    },
  );
});

test("uses named response-redaction groups as Builder context aliases", () => {
  assert.deepEqual(
    builderTemplateParameters(
      {},
      { userId: "session", unused: "ignored" },
      {
        requests: [
          {
            responseRedactions: [{ regex: '"userId":"(?<context_userId>[^\"]+)"' }],
          },
        ],
      },
    ),
    { context_userId: "session" },
  );
});

test("omits unused context and keeps explicit selected aliases", () => {
  const parameters = builderTemplateParameters(
    { context_userId: "explicit" },
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
          url: "https://provider.example.test/{{context_userId}}/{{context.accountId}}/{{reclaimSessionId}}/{{attestationNonce}}",
        },
      ],
    },
  );

  assert.deepEqual(parameters, {
    context_userId: "explicit",
    "context.accountId": "account",
  });
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
