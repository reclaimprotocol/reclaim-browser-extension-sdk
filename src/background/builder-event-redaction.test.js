import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NORMAL_MESSAGE_LENGTH,
  builderAuthRequiredEvents,
  builderAuthenticatedEvents,
  builderRequestMatchedAuthEvents,
  builderSignInProbeEvents,
  MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION,
  PROVIDER_SCRIPT_LOG_CAP_REACHED_MESSAGE,
  ProviderScriptLogAction,
  decideProviderScriptLogAction,
  providerScriptLogEventData,
  redactCredentials,
  requestClaimParametersCapturedEventData,
  sanitizeMessage,
  shouldEmitBrowserReady,
  shouldEmitPageReady,
  shouldEmitRequestInterceptorReady,
} from "./builder-event-redaction.js";

test("redactCredentials redacts cookies, authorization headers, bearer tokens, and secrets", () => {
  assert.equal(redactCredentials("Cookie: session=abc123"), "Cookie: [REDACTED]");
  assert.equal(redactCredentials("authorization: Basic dXNlcjpwYXNz"), "authorization: [REDACTED]");
  assert.equal(redactCredentials("Bearer eyJhbGciOiJIUzI1NiJ9.test.sig"), "Bearer [REDACTED]");
  assert.equal(redactCredentials("api_key: sk-12345"), "api_key: [REDACTED]");
  assert.equal(redactCredentials("password: hunter2"), "password: [REDACTED]");
});

test("redactCredentials redacts raw request/response bodies", () => {
  assert.equal(redactCredentials("responseBody=encrypted_data"), "responseBody=[REDACTED]");
});

test("redactCredentials leaves personal data untouched, unlike sanitizeMessage", () => {
  const input = "User logged in: user@example.com, phone=9998887777";
  const result = redactCredentials(input);
  assert.ok(result.includes("user@example.com"));
  assert.ok(result.includes("phone=9998887777"));
});

test("sanitizeMessage redacts both credentials and personal data", () => {
  const input = "Cookie: session=abc; user@test.com sent password=hunter2";
  const result = sanitizeMessage(input);
  assert.ok(!result.includes("session=abc"));
  assert.ok(!result.includes("user@test.com"));
  assert.ok(!result.includes("hunter2"));
});

test("providerScriptLogEventData normal mode sanitizes and truncates the message", () => {
  const longMessage = "a".repeat(MAX_NORMAL_MESSAGE_LENGTH + 100);
  const eventData = providerScriptLogEventData({
    level: "info",
    message: longMessage,
    diagnosticMode: false,
  });

  assert.equal(eventData.level, "info");
  assert.equal(eventData.message.length, MAX_NORMAL_MESSAGE_LENGTH);
});

test("providerScriptLogEventData normal mode redacts personal data from the message", () => {
  const eventData = providerScriptLogEventData({
    level: "info",
    message: "signed in as claimant@example.com",
    diagnosticMode: false,
  });

  assert.ok(!eventData.message.includes("claimant@example.com"));
});

test("providerScriptLogEventData diagnostic mode reports the full, untruncated message", () => {
  const longMessage = "b".repeat(MAX_NORMAL_MESSAGE_LENGTH + 100);
  const eventData = providerScriptLogEventData({
    level: "error",
    message: longMessage,
    diagnosticMode: true,
  });

  assert.equal(eventData.level, "error");
  assert.equal(eventData.message, longMessage);
});

test("providerScriptLogEventData diagnostic mode keeps personal data but still redacts credentials", () => {
  const eventData = providerScriptLogEventData({
    level: "info",
    message: "signed in as claimant@example.com with token=abc123secret",
    diagnosticMode: true,
  });

  assert.ok(eventData.message.includes("claimant@example.com"));
  assert.ok(!eventData.message.includes("abc123secret"));
});

test("requestClaimParametersCapturedEventData normal mode reports only sorted parameter names", () => {
  const eventData = requestClaimParametersCapturedEventData({
    parameterValuesByName: { username: "claimant", email: "claimant@example.com" },
    diagnosticMode: false,
  });

  assert.deepEqual(eventData.parameterNames, ["email", "username"]);
  assert.equal("parameterValues" in eventData, false);
});

test("requestClaimParametersCapturedEventData diagnostic mode reports names and values", () => {
  const eventData = requestClaimParametersCapturedEventData({
    parameterValuesByName: { username: "claimant42" },
    diagnosticMode: true,
  });

  assert.deepEqual(eventData.parameterNames, ["username"]);
  assert.deepEqual(eventData.parameterValues, { username: "claimant42" });
});

test("requestClaimParametersCapturedEventData diagnostic mode still redacts a credential-shaped parameter value", () => {
  const eventData = requestClaimParametersCapturedEventData({
    parameterValuesByName: { apiKey: "sk-live-abc123" },
    diagnosticMode: true,
  });

  assert.ok(!eventData.parameterValues.apiKey.includes("sk-live-abc123"));
});

test("decideProviderScriptLogAction reports every call up to and including the cap", () => {
  assert.equal(decideProviderScriptLogAction(1), ProviderScriptLogAction.REPORT);
  assert.equal(
    decideProviderScriptLogAction(MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION),
    ProviderScriptLogAction.REPORT,
  );
});

test("decideProviderScriptLogAction reports a cap-reached notice exactly once, right after the cap", () => {
  assert.equal(
    decideProviderScriptLogAction(MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION + 1),
    ProviderScriptLogAction.REPORT_CAP_REACHED_NOTICE,
  );
});

test("decideProviderScriptLogAction drops every call after the cap-reached notice", () => {
  assert.equal(
    decideProviderScriptLogAction(MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION + 2),
    ProviderScriptLogAction.DROP,
  );
  assert.equal(
    decideProviderScriptLogAction(MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION + 500),
    ProviderScriptLogAction.DROP,
  );
});

test("shouldEmitPageReady emits on the first page load for a provider", () => {
  assert.equal(shouldEmitPageReady({ hasAlreadyEmittedPageReadyForProvider: false }), true);
});

test("shouldEmitPageReady does not emit again once the provider already reported one", () => {
  assert.equal(shouldEmitPageReady({ hasAlreadyEmittedPageReadyForProvider: true }), false);
});

test("shouldEmitBrowserReady emits when the session has not reported one yet", () => {
  assert.equal(shouldEmitBrowserReady({ hasAlreadyEmittedBrowserReadyForSession: false }), true);
});

test("shouldEmitBrowserReady does not emit again once the session already reported one", () => {
  assert.equal(shouldEmitBrowserReady({ hasAlreadyEmittedBrowserReadyForSession: true }), false);
});

test("shouldEmitRequestInterceptorReady emits on the first load for a provider", () => {
  assert.equal(
    shouldEmitRequestInterceptorReady({
      hasAlreadyEmittedRequestInterceptorReadyForProvider: false,
    }),
    true,
  );
});

test("shouldEmitRequestInterceptorReady does not emit again once the provider already reported one", () => {
  assert.equal(
    shouldEmitRequestInterceptorReady({
      hasAlreadyEmittedRequestInterceptorReadyForProvider: true,
    }),
    false,
  );
});

test("PROVIDER_SCRIPT_LOG_CAP_REACHED_MESSAGE names the configured cap", () => {
  assert.ok(
    PROVIDER_SCRIPT_LOG_CAP_REACHED_MESSAGE.includes(
      String(MAX_PROVIDER_SCRIPT_LOG_EVENTS_PER_SESSION),
    ),
  );
});

const authBuilder = () => ({
  providerOrdinal: 1,
  currentProvider: freshAuthProvider("p1", "1.2.3"),
});

const freshAuthProvider = (providerId, resolvedVersion) => ({
  recipe: { providerId, resolvedVersion },
  hasReportedAuthRequired: false,
  hasReportedAuthGateNotDetected: false,
  hasReportedAuthenticated: false,
});

test("preexisting login reports auth_gate_not_detected then authenticated once per session", () => {
  const builder = authBuilder();
  const events = builderAuthenticatedEvents(builder);
  const provider = { providerId: "p1", resolvedVersion: "1.2.3", ordinal: 1 };
  assert.deepEqual(events, [
    [
      "auth_gate_not_detected",
      {
        ...provider,
        authStep: "PRIMARY",
        authMethod: "UNKNOWN",
        detectionMethod: "PROVIDER_SCRIPT",
      },
    ],
    [
      "authenticated",
      {
        ...provider,
        detectionMethod: "PROVIDER_SCRIPT",
        indicatorType: "PROVIDER_ASSERTION",
        authStateOrigin: "PREEXISTING",
        attemptCount: 0,
        mfaObserved: false,
      },
    ],
  ]);
  assert.deepEqual(builderAuthenticatedEvents(builder), []);
});

test("login after auth_required reports auth_required once, then COMPLETED_IN_SESSION without a gate event", () => {
  const builder = authBuilder();
  const [[name, data]] = builderAuthRequiredEvents(builder);
  assert.equal(name, "auth_required");
  assert.deepEqual(data, {
    providerId: "p1",
    resolvedVersion: "1.2.3",
    ordinal: 1,
    authStep: "PRIMARY",
    authMethod: "UNKNOWN",
    detectionMethod: "PROVIDER_SCRIPT",
    indicatorType: "AUTH_FORM",
  });
  assert.deepEqual(builderAuthRequiredEvents(builder), []);
  const events = builderAuthenticatedEvents(builder);
  assert.deepEqual(
    events.map(([event]) => event),
    ["authenticated"],
  );
  assert.equal(events[0][1].authStateOrigin, "COMPLETED_IN_SESSION");
});

test("each provider in a session reports its own auth events once", () => {
  const builder = authBuilder();
  builderAuthRequiredEvents(builder);
  assert.equal(builderAuthenticatedEvents(builder).length, 1);
  assert.deepEqual(builderAuthenticatedEvents(builder), []);

  builder.providerOrdinal = 2;
  builder.currentProvider = freshAuthProvider("p2", "2.0.0");
  const events = builderAuthenticatedEvents(builder);
  assert.deepEqual(
    events.map(([event]) => event),
    ["auth_gate_not_detected", "authenticated"],
  );
  assert.equal(events[1][1].providerId, "p2");
  assert.equal(events[1][1].ordinal, 2);
  assert.equal(events[1][1].authStateOrigin, "PREEXISTING");
});

const probeNames = (builder, ...probes) =>
  probes.flatMap((probe) =>
    builderSignInProbeEvents(builder, probe).map(([name, data]) => [name, data]),
  );
const URL_PROBE = { indicator: "url", hasPassword: false };
const NONE_PROBE = { indicator: "none", hasPassword: false };

test("sign-in probe: login completed in session emits auth_required then authenticated once each", () => {
  const builder = authBuilder();
  const events = probeNames(
    builder,
    URL_PROBE,
    URL_PROBE,
    URL_PROBE,
    NONE_PROBE,
    NONE_PROBE,
    NONE_PROBE,
    URL_PROBE,
    URL_PROBE,
  );
  assert.deepEqual(
    events.map(([name]) => name),
    ["auth_required", "authenticated"],
  );
  assert.equal(events[0][1].detectionMethod, "URL_CHANGE");
  assert.equal(events[0][1].indicatorType, "AUTH_REDIRECT");
  assert.deepEqual(
    { ...events[1][1], providerId: undefined },
    {
      providerId: undefined,
      resolvedVersion: "1.2.3",
      ordinal: 1,
      detectionMethod: "DOM_INDICATOR",
      indicatorType: "POST_AUTH_ROUTE",
      authStateOrigin: "COMPLETED_IN_SESSION",
      attemptCount: 0,
      mfaObserved: false,
    },
  );
  assert.deepEqual(builderRequestMatchedAuthEvents(builder), []);
});

test("sign-in probe: element maps to PASSWORD_FIELD or AUTH_FORM", () => {
  const withPassword = probeNames(
    authBuilder(),
    ...Array(2).fill({ indicator: "element", hasPassword: true }),
  );
  assert.equal(withPassword[0][1].detectionMethod, "DOM_INDICATOR");
  assert.equal(withPassword[0][1].indicatorType, "PASSWORD_FIELD");
  const without = probeNames(
    authBuilder(),
    ...Array(2).fill({ indicator: "element", hasPassword: false }),
  );
  assert.equal(without[0][1].indicatorType, "AUTH_FORM");
});

test("sign-in probe: flapping emits nothing until stable", () => {
  const builder = authBuilder();
  assert.deepEqual(
    probeNames(builder, URL_PROBE, NONE_PROBE, URL_PROBE, NONE_PROBE, URL_PROBE),
    [],
  );
  assert.equal(probeNames(builder, URL_PROBE).length, 1);
});

test("sign-in probe: none alone and invalid readings emit nothing", () => {
  const builder = authBuilder();
  assert.deepEqual(
    probeNames(builder, NONE_PROBE, NONE_PROBE, NONE_PROBE, { indicator: false }, {}),
    [],
  );
});

test("request_matched: preexisting login emits authenticated NETWORK/PREEXISTING once", () => {
  const builder = authBuilder();
  const [[name, data]] = builderRequestMatchedAuthEvents(builder);
  assert.equal(name, "authenticated");
  assert.equal(data.detectionMethod, "NETWORK");
  assert.equal(data.indicatorType, "AUTHENTICATED_RESPONSE");
  assert.equal(data.authStateOrigin, "PREEXISTING");
  assert.deepEqual(builderRequestMatchedAuthEvents(builder), []);
  assert.deepEqual(probeNames(builder, URL_PROBE, URL_PROBE, NONE_PROBE, NONE_PROBE), []);
});

test("request_matched after auth_required is COMPLETED_IN_SESSION and stops the none rule", () => {
  const builder = authBuilder();
  probeNames(builder, URL_PROBE, URL_PROBE);
  const [[, data]] = builderRequestMatchedAuthEvents(builder);
  assert.equal(data.authStateOrigin, "COMPLETED_IN_SESSION");
  assert.deepEqual(probeNames(builder, NONE_PROBE, NONE_PROBE), []);
});

test("provider-script signals take the shared once-per-execution flags", () => {
  const scripted = authBuilder();
  builderAuthRequiredEvents(scripted);
  assert.deepEqual(probeNames(scripted, URL_PROBE, URL_PROBE), []);
  assert.equal(builderAuthenticatedEvents(scripted).length, 1);
  assert.deepEqual(probeNames(scripted, NONE_PROBE, NONE_PROBE), []);
  assert.deepEqual(builderRequestMatchedAuthEvents(scripted), []);

  const generic = authBuilder();
  probeNames(generic, URL_PROBE, URL_PROBE);
  assert.deepEqual(builderAuthRequiredEvents(generic), []);
});

test("sign-in probe state resets for the next provider", () => {
  const builder = authBuilder();
  probeNames(builder, URL_PROBE, URL_PROBE, NONE_PROBE);
  builder.currentProvider = {
    ...freshAuthProvider("p2", "2.0.0"),
    signInLastIndicator: null,
    signInStreak: 0,
  };
  assert.equal(probeNames(builder, URL_PROBE, URL_PROBE).length, 1);
});
