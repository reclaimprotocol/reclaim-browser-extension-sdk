/**
 * The user-visible contract this file protects:
 *
 *  1. ONE threshold, `logLevel`, governs the console and the endpoint together,
 *     and it decides redaction: INFO blanks values, FINE keeps them raw. A stock
 *     install therefore sends no user data anywhere.
 *  2. Levels are spelled the way the rest of the platform spells them
 *     (SEVERE/WARNING/INFO/FINE), so extension sessions filter alongside the
 *     InApp SDK's; the older ERROR/WARN/DEBUG spellings still resolve.
 *  3. Every entry carries the SDK identity and the session identifiers, so a
 *     single line lifted out of Loki is attributable.
 *  4. A repeat inside the dedupe window is counted, not discarded.
 *  5. One giant line cannot blow up the batch that carries every other log.
 *
 * The hub talks to `chrome.*` and `fetch`, both stubbed here. It is also a
 * singleton claimed at module import, so this file drives that one instance;
 * node:test gives each file its own process, so there is no cross-file bleed.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";

import { EVENT_TYPES, DEFAULT_LOG_CONFIG } from "./constants.js";

const storage = { local: new Map(), session: new Map() };
const sent = [];

function installChromeStub() {
  const area = (map) => ({
    get: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    remove: async (key) => {
      map.delete(key);
    },
  });

  globalThis.chrome = {
    storage: {
      local: area(storage.local),
      session: area(storage.session),
      onChanged: { addListener() {} },
    },
    runtime: { onSuspend: { addListener() {} }, getManifest: () => ({ version: "9.9.9" }) },
    // No chrome.alarms: exercises the setInterval fallback path.
  };

  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  };
}

let hub;
let truncateLine;

before(async () => {
  installChromeStub();
  const mod = await import("./LoggingHub.js");
  hub = mod.loggingHub;
  truncateLine = mod.truncateLine;

  // Force the deferred init to run now (it fires on first use), then neutralise
  // the timers it started so they cannot drain the queue mid-assertion or hold
  // the test process open. The stub has no chrome.alarms, so this also confirms
  // the setInterval fallback is the path taken without it.
  hub.flushIntervalMs = 60_000;
  hub._addLog("bootstrap", "test.bootstrap", "DEBUG");
  await hub.ready;
  assert.ok(hub.flushIntervalId, "expected the setInterval fallback with no chrome.alarms");
  hub.flushIntervalId.unref?.();
});

beforeEach(() => {
  hub.logs = [];
  sent.length = 0;
  hub._recentLogHashes.clear();
  // Most tests here are about queueing mechanics rather than redaction, so the
  // shared default is the verbose end; the tests that care set their own.
  hub.config = { logLevel: "FINE", consoleEnabled: false };
  // Auto-flush on batch size is real behaviour, exercised in its own test
  // below; left on here it would drain the queue the other assertions read.
  hub.maxBatchSize = Infinity;
});

describe("one threshold governs both destinations", () => {
  it("emits nothing below the threshold, to either destination", () => {
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => captured.push(args);
    try {
      hub.config = { logLevel: "INFO", consoleEnabled: true };
      hub.debug("fine-detail", "test.category");
    } finally {
      console.log = realLog;
    }

    assert.equal(hub.logs.length, 0, "a FINE line is not queued at INFO");
    assert.equal(captured.length, 0, "and it is not printed either");
  });

  it("keeps WARNING and SEVERE visible at the INFO default", () => {
    // Severity is a floor, not a filter: the labels exist so a query can
    // isolate failures, never to hide them from the default configuration.
    hub.config = { logLevel: "INFO", consoleEnabled: false };
    hub.error("boom", "test.category");
    hub.warn("careful", "test.category");
    hub.info("normal", "test.category");
    hub.debug("verbose", "test.category");

    assert.deepEqual(
      hub.logs.map((l) => l.logLine),
      ["boom", "careful", "normal"],
    );
  });

  it("queues FINE once the threshold is FINE", () => {
    hub.config = { logLevel: "FINE", consoleEnabled: false };
    hub.debug("fine-detail", "test.category");
    assert.deepEqual(
      hub.logs.map((l) => l.logLine),
      ["fine-detail"],
    );
  });

  it("stamps the platform's level spelling, not the old one", () => {
    // The log viewer filters severity on `fine|config|info|warning|severe`.
    // Emitting ERROR/WARN/DEBUG made extension sessions unfilterable next to
    // the InApp SDK's.
    hub.config = { logLevel: "FINE", consoleEnabled: false };
    hub.error("a", "t");
    hub.warn("b", "t");
    hub.info("c", "t");
    hub.debug("d", "t");

    assert.deepEqual(
      hub.logs.map((l) => l.logLevel),
      ["SEVERE", "WARNING", "INFO", "FINE"],
    );
  });

  it("accepts the pre-rename spellings from a persisted config", () => {
    // A consumer who called setLogConfig({ logLevel: "DEBUG" }) before the
    // rename still has that value in chrome.storage.local.
    hub.config = { logLevel: "DEBUG", consoleEnabled: false };
    hub.debug("still-verbose", "test.category");
    assert.equal(hub.logs.length, 1, "DEBUG must still mean FINE");

    hub.logs = [];
    hub.config = { logLevel: "ERROR", consoleEnabled: false };
    hub.info("dropped", "test.category");
    hub.error("kept", "test.category");
    assert.deepEqual(
      hub.logs.map((l) => l.logLine),
      ["kept"],
    );
  });
});

describe("redaction follows the level, not the destination", () => {
  const TEMPLATE = {
    sessionId: "sess-1",
    signature: "0xsignaturevalue",
    parameters: { accountNumber: "1234567890" },
  };

  it("redacts at INFO on the way to the endpoint", () => {
    hub.config = { logLevel: "INFO", consoleEnabled: false };
    hub.info("Starting verification:", "background.verification", { payload: TEMPLATE });

    const line = hub.logs[0].logLine;
    assert.ok(!line.includes("0xsignaturevalue"), "signature must not reach the endpoint");
    assert.ok(!line.includes("1234567890"), "user parameters must not reach the endpoint");
    assert.ok(line.includes("accountNumber"), "field names stay: they are the diagnostic");
    assert.ok(line.includes("sess-1"), "innocuous fields are untouched");
  });

  it("redacts the CONSOLE at INFO too", () => {
    // The property the old destination-based split could not express. The
    // console is the provider tab's console; at the default level it must not
    // show the user their own extracted data either.
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => captured.push(args);
    try {
      hub.config = { logLevel: "INFO", consoleEnabled: true };
      hub.info("Starting verification:", "background.verification", { payload: TEMPLATE });
    } finally {
      console.log = realLog;
    }

    assert.equal(captured.length, 1);
    // Last argument: the line is emitted as a literal format string plus its
    // substitutions, so the payload is no longer at index 1.
    const shown = captured[0].at(-1);
    // Still an object, so devtools renders a tree — but a redacted copy, and
    // emphatically not the caller's live object.
    assert.notEqual(shown, TEMPLATE, "the console must not get the live object at INFO");
    assert.ok(!JSON.stringify(shown).includes("0xsignaturevalue"));
    assert.ok(!JSON.stringify(shown).includes("1234567890"));
  });

  it("gives both destinations the raw values at FINE", () => {
    const captured = [];
    const realLog = console.log;
    console.log = (...args) => captured.push(args);
    try {
      hub.config = { logLevel: "FINE", consoleEnabled: true };
      hub.info("Starting verification:", "background.verification", { payload: TEMPLATE });
    } finally {
      console.log = realLog;
    }

    // This is the point of FINE: a client's failing session is diagnosed from
    // Loki, so the endpoint gets exactly what the console gets.
    const line = hub.logs[0].logLine;
    assert.ok(line.includes("0xsignaturevalue"), "FINE ships the real value remotely");
    assert.ok(line.includes("1234567890"));
    assert.equal(captured[0].at(-1), TEMPLATE, "the console gets the live object at FINE");
  });

  it("caps the redacted line, and allows a much longer raw one", () => {
    hub.config = { logLevel: "INFO", consoleEnabled: false };
    hub.info("big:", "test.category", { payload: { blob: "z".repeat(40000) } });
    assert.ok(hub.logs[0].logLine.length < 2100, "a redacted line stays at the normal cap");

    hub.logs = [];
    hub._recentLogHashes.clear();
    hub.config = { logLevel: "FINE", consoleEnabled: false };
    hub.info("big:", "test.category", { payload: { blob: "z".repeat(40000) } });
    assert.ok(hub.logs[0].logLine.length > 20000, "a raw claim must not be cut in half");
    assert.ok(hub.logs[0].logLine.length <= 100_100, "but the bound is still finite");
  });
});

describe("no user data reaches the endpoint at the default level", () => {
  // The regression this file exists for. Everything below was, at one point,
  // POSTed to Loki by a stock install that had called nothing.
  const CLAIM = {
    name: "http",
    params: {
      url: "https://etherscan.io/myaccount",
      paramValues: { etherscanaccount: "sajjad21990" },
    },
    secretParams: {
      cookieStr: "ASP.NET_SessionId=deadbeef; etherscan_pwd=hunter2",
      paramValues: { secretToken: "tok-abc123" },
    },
    ownerPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    signature: "0xsignaturevalue",
  };

  // A formatted proof as sessionManager builds it. `claimData` is the
  // attestor's claim: `parameters` and `context` arrive as JSON *strings*, and
  // `context.extractedParameters` is the plaintext value being proven.
  const PROOF = {
    identifier: "0xe46c982a",
    claimData: {
      provider: "http",
      parameters: JSON.stringify({ paramValues: { username: "sajjad21990" } }),
      context: JSON.stringify({ extractedParameters: { username: "sajjad21990" } }),
      owner: "0xowner",
    },
    signatures: ["0x0ed30f08"],
    witnesses: [{ id: "0x24489757", url: "wss://attestor.reclaimprotocol.org/ws" }],
    publicData: "scraped-display-name",
    providerRequest: { url: "https://kaggle.com/api", method: "POST", urlType: "TEMPLATE" },
  };

  const SECRETS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "ASP.NET_SessionId=deadbeef",
    "etherscan_pwd=hunter2",
    "tok-abc123",
    "sajjad21990",
    "0xsignaturevalue",
    "scraped-display-name",
  ];

  it("blanks the claim at the stock defaults", () => {
    hub.config = { ...DEFAULT_LOG_CONFIG };
    hub.info("[CLAIM-CREATOR] Claim object:", "claim.creation", { payload: CLAIM });

    const line = hub.logs[0]?.logLine ?? "";
    for (const secret of SECRETS) {
      assert.ok(!line.includes(secret), `${secret} LEAKED at stock defaults`);
    }
    assert.ok(line.includes("<redacted"), "values are blanked, not the whole line dropped");
    // Key names survive where they are diagnostic and the value is not the
    // secret itself — `secretParams` is blanked whole, but the shape around it
    // still says which parameters the claim carried.
    assert.ok(line.includes("etherscanaccount"), "param NAMES survive; their values do not");
    assert.ok(line.includes("https://etherscan.io/myaccount"), "the provider url is config");
  });

  it("blanks claimData wholesale in a submitted proof", () => {
    // `claimData.context.extractedParameters` is the proven value itself. The
    // InApp SDK blanks exactly this field in its own PROOF_GENERATED line, and
    // walking into it key-by-key would expose every field the attestor adds
    // later until someone remembered to list it.
    hub.config = { ...DEFAULT_LOG_CONFIG };
    hub.info("[BACKGROUND] Submitting proofs", "background.proof", { payload: [PROOF] });

    const line = hub.logs[0].logLine;
    assert.ok(!line.includes("sajjad21990"), "the proven value must not reach Loki");
    assert.ok(!line.includes("extractedParameters"), "not even the key");
    assert.ok(line.includes('"claimData":"[REDACTED]"'));
    // What stays is what makes the line worth having.
    assert.ok(line.includes("0xe46c982a"), "the identifier survives");
    assert.ok(line.includes("0x24489757"), "so does the attestor that signed it");
    assert.ok(line.includes("urlType"), "and the provider request");
  });

  it("blanks a provider script's return value, whatever keys it invents", () => {
    // A customInjection can return anything; no substring rule can anticipate
    // its key names, so the whole value is opaque at INFO.
    hub.config = { ...DEFAULT_LOG_CONFIG };
    hub.info("[BACKGROUND] RUN_CUSTOM_INJECTION result", "background.injection", {
      payload: { injectionResult: { emailAddress: "user@example.com", tier: "gold" } },
    });

    const line = hub.logs[0].logLine;
    assert.ok(!line.includes("user@example.com"));
    assert.ok(!line.includes("emailAddress"));
    assert.ok(line.includes('"injectionResult":"[REDACTED]"'));
  });

  it("keeps the message itself, so the timeline survives redaction", () => {
    hub.config = { ...DEFAULT_LOG_CONFIG };
    hub.info("[CLAIM-CREATOR] Claim object:", "claim.creation", { payload: CLAIM });
    assert.ok(
      hub.logs[0].logLine.startsWith("[CLAIM-CREATOR] Claim object:"),
      "the marker that the flow got this far must not be lost",
    );
  });

  it("ships all of it at FINE, including across the relay", () => {
    // offscreen.js logs the final claimData through RemoteLogger, so the level
    // has to survive the chrome-messaging hop into handleRemoteLog.
    hub.config = { logLevel: "FINE", consoleEnabled: false };
    hub.handleRemoteLog(
      "[OFFSCREEN] Final claimData for attestor",
      "offscreen.proof",
      "FINE",
      "offscreen",
      { payload: CLAIM },
    );

    const entry = hub.logs[0];
    assert.equal(entry.context, "offscreen");
    assert.ok(entry.logLine.includes("ASP.NET_SessionId=deadbeef"));
    assert.ok(
      entry.logLine.includes("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
    );
  });

  it("reports a successful extraction without publishing what was extracted", () => {
    // The success half of the extraction chain is logged at INFO on purpose: a
    // selector that resolves to the wrong region is otherwise indistinguishable
    // from one that was never evaluated until the attestor rejects the claim.
    // What makes that safe is that the selector and the value LENGTH carry the
    // diagnosis, while the value itself rides the payload under a key the
    // redactor treats as opaque.
    hub.config = { ...DEFAULT_LOG_CONFIG };
    hub.info(
      "[PARAM-EXTRACTOR] responseMatch #0 resolved via template: userName(len=11)",
      "claim.params",
      { payload: { extractedParameters: { userName: "sajjad21990" } } },
    );

    const line = hub.logs[0].logLine;
    assert.ok(!line.includes("sajjad21990"), "the extracted value must not reach the endpoint");
    assert.ok(line.includes("len=11"), "its length is the substitute, and is the diagnostic");
    assert.ok(line.includes('"extractedParameters":"[REDACTED]"'));

    hub.logs = [];
    hub._recentLogHashes.clear();
    hub.config = { logLevel: "FINE", consoleEnabled: false };
    hub.info(
      "[PARAM-EXTRACTOR] responseMatch #0 resolved via template: userName(len=11)",
      "claim.params",
      { payload: { extractedParameters: { userName: "sajjad21990" } } },
    );
    assert.ok(
      hub.logs[0].logLine.includes("sajjad21990"),
      "FINE is what a remote client debug session turns on",
    );
  });
});

describe("eventType", () => {
  it("stamps the cross-SDK lifecycle name on the entry", () => {
    hub.info("Fetched providers", "background.provider", {
      eventType: "FETCHED_PROVIDERS",
    });
    assert.equal(hub.logs[0].eventType, "FETCHED_PROVIDERS");
    // The dotted category is a separate axis and survives alongside it.
    assert.equal(hub.logs[0].type, "background.provider");
  });

  it("defaults to UNKNOWN rather than omitting the field", () => {
    // Always present, so it can be a Loki label without holes.
    hub.info("no event name", "test.category");
    assert.equal(hub.logs[0].eventType, "UNKNOWN");
  });

  it("carries through a relayed log", () => {
    hub.handleRemoteLog(
      "Intercepted GET https://x/y",
      "interceptor.network",
      "INFO",
      "interceptor",
      {
        eventType: "REQUEST_INTERCEPTED",
      },
    );
    assert.equal(hub.logs[0].eventType, "REQUEST_INTERCEPTED");
    assert.equal(hub.logs[0].context, "interceptor");
  });

  it("does not collapse the same wording at two different lifecycle points", () => {
    // The dedupe key includes eventType: identical text meaning two different
    // things is two events, and losing one loses the transition.
    hub.info("same words", "test.category", { eventType: "PREPARING_CLAIM" });
    hub.info("same words", "test.category", { eventType: "CLAIM_CREATION_STARTED" });
    assert.equal(hub.logs.length, 2);
  });

  it("uses names that exist in the InApp SDK where one exists", () => {
    // Guards the renames: these spellings are the InApp ones, and drifting back
    // to the old extension-local names silently breaks cross-SDK queries.
    const names = new Set(Object.keys(EVENT_TYPES));
    for (const inApp of [
      "NO_RESPONSE_MATCH_WARNING",
      "PROOF_GENERATED",
      "PROOF_GENERATION_FAILED_EXCEPTION",
      "CLAIM_CREATION_CANCELLED_EXCEPTION",
      "RECLAIM_EXCEPTION",
      "FETCHED_PROVIDERS",
      "REQUEST_INTERCEPTED",
      "PROVIDER_SCRIPT_REQUESTED_CLAIM",
      "CLAIM_CREATION_TIMED_OUT_EXCEPTION",
    ]) {
      assert.ok(names.has(inApp), `missing InApp name ${inApp}`);
    }
    for (const retired of [
      "RESPONSE_MATCH_FAILED",
      "CLAIM_CREATION_SUCCESS",
      "CLAIM_CREATION_FAILED",
      "PROOF_GENERATION_ABORTED",
      "VERIFICATION_FLOW_FAILED",
      "FILTERED_REQUEST_FOUND",
      "SUBMITTING_PROOF_TO_CALLBACK_URL",
    ]) {
      assert.ok(!names.has(retired), `${retired} was renamed away; do not reintroduce it`);
    }
    // Every value must equal its key, or a call site's constant and the stored
    // string diverge.
    for (const [key, value] of Object.entries(EVENT_TYPES)) {
      assert.equal(key, value, `EVENT_TYPES.${key} !== "${value}"`);
    }
  });
});

describe("entry shape", () => {
  it("stamps SDK identity, context and session identifiers on every entry", () => {
    hub.sessionContext = { sessionId: "sess-1", providerId: "prov-1", appId: "app-1" };
    hub.info("hello", "test.category");

    const entry = hub.logs[0];
    assert.equal(entry.sessionId, "sess-1");
    assert.equal(entry.providerId, "prov-1");
    assert.equal(entry.appId, "app-1");
    assert.equal(entry.logLevel, "INFO");
    assert.equal(entry.type, "test.category");
    assert.equal(entry.context, "background");
    assert.ok(entry.source.includes("browser-extension-sdk"), "entry must name the SDK");
    assert.ok(/^\d+$/.test(entry.ts), "ts is Loki nanoseconds");
  });

  it("labels a relayed log with its originating context, not background", () => {
    // "WARN" is the pre-rename spelling: a page-world script built before the
    // rename can still be the one relaying, so it must normalize on arrival
    // rather than reaching Loki under a name the viewer cannot filter.
    hub.handleRemoteLog("from the page", "interceptor.network", "WARN", "interceptor");
    assert.equal(hub.logs[0].context, "interceptor");
    assert.equal(hub.logs[0].logLevel, "WARNING");
  });

  it("falls back to 'unknown' rather than dropping a log with no session", () => {
    hub.sessionContext = { sessionId: null, providerId: null, appId: null };
    hub.info("before any session", "test.category");
    assert.equal(hub.logs.length, 1);
    assert.equal(hub.logs[0].sessionId, "unknown");
  });
});

describe("deduplication", () => {
  it("counts a repeat instead of silently discarding it", () => {
    hub.info("same line", "test.category");
    hub.info("same line", "test.category");
    hub.info("same line", "test.category");

    assert.equal(hub.logs.length, 1, "repeats collapse into one entry");
    assert.equal(hub.logs[0].repeated, 3, "but the count survives");
  });

  it("does not collapse the same wording from two different contexts", () => {
    hub.handleRemoteLog("identical", "test.category", "INFO", "content");
    hub.handleRemoteLog("identical", "test.category", "INFO", "offscreen");
    assert.equal(hub.logs.length, 2);
  });

  it("does not collapse the same wording at two different levels", () => {
    hub.info("identical", "test.category");
    hub.error("identical", "test.category");
    assert.equal(hub.logs.length, 2);
  });
});

describe("truncateLine", () => {
  it("leaves normal lines untouched", () => {
    assert.equal(truncateLine("short"), "short");
  });

  it("caps a huge line and keeps both ends", () => {
    const huge = "HEAD" + "x".repeat(50000) + "TAIL";
    const out = truncateLine(huge);
    assert.ok(out.length < 2100, `expected a capped line, got ${out.length}`);
    assert.ok(out.startsWith("HEAD"), "the start says what happened");
    assert.ok(out.endsWith("TAIL"), "the end usually holds the error");
    assert.ok(out.includes("chars truncated"));
  });

  it("is applied to queued entries", () => {
    hub.info("y".repeat(40000), "test.category");
    assert.ok(hub.logs[0].logLine.length < 2100);
  });

  it("stringifies non-string input rather than throwing", () => {
    assert.equal(truncateLine(undefined), "");
    assert.equal(truncateLine(42), "42");
  });
});

describe("flush", () => {
  it("sends the batch with the SDK identity as the envelope source", async () => {
    hub.info("one", "test.category");
    hub.info("two", "test.category");
    await hub.flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].logs.length, 2);
    assert.ok(sent[0].source.includes("browser-extension-sdk"));
    assert.ok(sent[0].deviceId);
  });

  it("re-queues the batch when the endpoint rejects it", async () => {
    const ok = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    try {
      hub.info("must not be lost", "test.category");
      await hub.flush();
      assert.equal(hub.logs.length, 1, "a failed POST must not consume the logs");
      assert.equal(hub.logs[0].logLine, "must not be lost");
    } finally {
      globalThis.fetch = ok;
    }
  });

  it("re-queues when the request throws outright", async () => {
    const ok = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    try {
      hub.info("offline log", "test.category");
      await hub.flush();
      assert.equal(hub.logs.length, 1);
    } finally {
      globalThis.fetch = ok;
    }
  });

  it("is a no-op with an empty queue", async () => {
    await hub.flush();
    assert.equal(sent.length, 0);
  });

  it("never skips a batch because another flush is in flight", async () => {
    // Regression guard, from a real loss: a session's last 14 seconds — the
    // proof failure and the failSession path, i.e. the only logs that explained
    // the failure — never reached the endpoint, while everything before them
    // did. flush() used to return early whenever `isFlushing` was set and
    // forceFlush() polled for just one second before calling it anyway, so a
    // terminal flush that overlapped a slow periodic POST silently sent nothing.
    const ok = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      // The first POST stays open longer than the old one-second poll, which is
      // what made that poll useless — 1.2s is an ordinary slow mobile request.
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1200));
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 201 };
    };
    try {
      hub.info("first batch", "test.category");
      const slow = hub.flush();

      // Terminal logs arrive while the first POST is still open.
      hub.info("the failure everyone needs", "test.category");
      const terminal = hub.forceFlush();

      await Promise.all([slow, terminal]);

      const lines = sent.flatMap((b) => b.logs.map((l) => l.logLine));
      assert.ok(
        lines.includes("the failure everyone needs"),
        `terminal batch was dropped; endpoint only got ${JSON.stringify(lines)}`,
      );
      assert.equal(hub.logs.length, 0, "nothing may be left queued after both flushes");
    } finally {
      globalThis.fetch = ok;
    }
  });
});

describe("session context", () => {
  it("keeps the identifiers on logs emitted after a terminal path", async () => {
    // failSession() calls clearSessionContext() and the flow then keeps going:
    // it notifies tabs, broadcasts to the popup and answers further messages.
    // Nulling the ids there stamped all of that "unknown", which does not just
    // lose attribution — it makes those lines unreachable from a sessionId
    // query, i.e. invisible in the one view used to debug the failure.
    hub.setSessionContext({ sessionId: "abc123", providerId: "prov", appId: "app" });
    await hub.clearSessionContext();

    hub.info("emitted after failSession", "test.category");

    assert.equal(hub.logs.at(-1).sessionId, "abc123");
    assert.equal(hub.logs.at(-1).providerId, "prov");
  });

  it("does not let a restored context clobber one just set", async () => {
    storage.session.set("reclaim_log_session_context", {
      sessionId: "stale",
      providerId: "old",
      appId: "old",
    });
    hub.setSessionContext({ sessionId: "current", providerId: "p", appId: "a" });

    await hub._restoreSessionContext();

    assert.equal(hub.sessionContext.sessionId, "current");
  });
});

describe("service-worker restart", () => {
  it("mirrors the pending queue into session storage", () => {
    hub.info("survives teardown", "test.category");
    const persisted = storage.session.get("reclaim_extension_sdk_log_queue");
    assert.ok(Array.isArray(persisted), "queue must be mirrored, not memory-only");
    assert.equal(persisted.at(-1).logLine, "survives teardown");
  });

  it("clears the mirror once the batch is sent", async () => {
    hub.info("transient", "test.category");
    await hub.flush();
    assert.equal(storage.session.get("reclaim_extension_sdk_log_queue"), undefined);
  });

  it("recovers logs left behind by a previous worker lifetime", async () => {
    const orphan = { logLine: "from the previous life", ts: "1", logLevel: "INFO" };
    storage.session.set("reclaim_extension_sdk_log_queue", [orphan]);

    await hub._drainPersisted();

    assert.equal(hub.logs[0].logLine, "from the previous life");
    assert.equal(
      storage.session.get("reclaim_extension_sdk_log_queue"),
      undefined,
      "recovered logs must not be replayed a second time",
    );
  });
});

describe("batching", () => {
  it("flushes as soon as the batch size is reached", async () => {
    hub.maxBatchSize = 3;
    hub.info("a", "test.category");
    hub.info("b", "test.category");
    hub.info("c", "test.category");
    // The flush is kicked off synchronously inside the third _addLog; let the
    // POST settle.
    await hub.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].logs.length, 3);
  });
});

describe("queue cap", () => {
  it("drops the oldest logs rather than growing without bound", () => {
    for (let i = 0; i < hub.maxQueueSize + 25; i++) {
      // Distinct messages so dedupe does not interfere.
      hub._addLog(`log ${i}`, "test.category", "INFO");
    }
    assert.equal(hub.logs.length, hub.maxQueueSize);
    assert.ok(hub.stats.totalLogsDropped >= 25);
    // The survivors are the newest.
    assert.equal(hub.logs.at(-1).logLine, `log ${hub.maxQueueSize + 24}`);
  });
});
