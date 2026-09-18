import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NORMAL_MESSAGE_LENGTH,
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
