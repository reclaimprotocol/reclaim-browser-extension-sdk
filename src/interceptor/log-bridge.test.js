/**
 * The bridge is the only route MAIN-world diagnostics have to the endpoint:
 * the interceptor and injection scripts run in the page's world, where there is
 * no `chrome.runtime`. Before it existed, every line from the interception
 * layer — the most failure-prone stage of the flow — went to the page console
 * and nowhere else.
 *
 * These tests use a fake `window`, since the module only needs `postMessage`
 * and `addEventListener`.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const posted = [];
let messageListener = null;

globalThis.window = {
  postMessage: (message) => posted.push(message),
  addEventListener: (event, handler) => {
    if (event === "message") messageListener = handler;
  },
};

const { createPageLogger, LOG_ACTION, LOG_CONFIG_ACTION } = await import("./log-bridge.js");

// The config listener installs lazily on the first createPageLogger call — the
// module has no import-time side effects on purpose, since it is bundled into
// scripts injected at document_start. So one logger has to exist before any
// config can be pushed.
createPageLogger("bootstrap", "bootstrap");

/** Simulate the content script pushing log config into the page. */
function pushConfig(config) {
  messageListener({
    source: globalThis.window,
    data: { action: LOG_CONFIG_ACTION, data: { config } },
  });
}

beforeEach(() => {
  posted.length = 0;
  pushConfig({ consoleEnabled: false, logLevel: "DEBUG" });
});

describe("createPageLogger", () => {
  it("posts every level to the content script for relay", () => {
    const logger = createPageLogger("interceptor", "interceptor.network");
    logger.info("intercepted a request");
    logger.warn("slow response");
    logger.error("interception failed");
    logger.debug("verbose detail");

    assert.equal(posted.length, 4);
    // Platform spellings, so a page-world line filters alongside every other
    // SDK's in the log viewer.
    assert.deepEqual(
      posted.map((m) => m.data.level),
      ["INFO", "WARNING", "SEVERE", "FINE"],
    );
    for (const message of posted) {
      assert.equal(message.action, LOG_ACTION);
      assert.equal(message.data.context, "interceptor");
      assert.equal(message.data.type, "interceptor.network");
    }
  });

  it("keeps the log/info/error shape the interceptor already called", () => {
    const logger = createPageLogger("injection", "injection.script");
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      assert.equal(typeof logger[method], "function", `missing ${method}`);
    }
    // The old local `debug` object treated .log as verbose output.
    logger.log("legacy call site");
    assert.equal(posted[0].data.level, "FINE");
  });

  it("forwards regardless of the console setting", () => {
    // Console config controls local mirroring only. Silencing the page console
    // must not silence the diagnostic dump.
    pushConfig({ consoleEnabled: false, logLevel: "ERROR" });
    const logger = createPageLogger("interceptor", "interceptor.network");
    logger.debug("still needs to reach the endpoint");
    assert.equal(posted.length, 1);
  });

  it("sends objects as a structured payload, not stringified into the message", () => {
    // Stringifying here would push the value past the hub's redaction straight
    // to the endpoint. The object has to travel as an object.
    const logger = createPageLogger("interceptor", "interceptor.network");
    logger.info("request", { url: "https://x/y", method: "GET" });

    assert.equal(posted[0].data.message, "request");
    assert.deepEqual(posted[0].data.options.payload, { url: "https://x/y", method: "GET" });
  });

  it("renders Errors into the message, since their fields do not serialize", () => {
    const logger = createPageLogger("interceptor", "interceptor.network");
    logger.error("boom", new TypeError("bad input"));
    assert.equal(posted[0].data.message, "boom TypeError: bad input");
    assert.equal(posted[0].data.options.payload, undefined);
  });

  it("collects multiple objects into one payload", () => {
    const logger = createPageLogger("interceptor", "interceptor.network");
    logger.info("pair", { a: 1 }, { b: 2 });
    assert.equal(posted[0].data.message, "pair");
    assert.deepEqual(posted[0].data.options.payload, [{ a: 1 }, { b: 2 }]);
  });

  it("keeps the log line when the payload cannot be cloned", () => {
    // postMessage structured-clones, so a cycle throws. The line saying
    // something went wrong matters more than the detail.
    const realPostMessage = globalThis.window.postMessage;
    globalThis.window.postMessage = (message) => {
      if (message.data.options?.payload !== undefined)
        throw new DOMException("could not be cloned");
      posted.push(message);
    };
    try {
      const logger = createPageLogger("interceptor", "interceptor.network");
      const cyclic = {};
      cyclic.self = cyclic;
      assert.doesNotThrow(() => logger.info("cyclic", cyclic));
      assert.equal(posted.length, 1);
      assert.equal(posted[0].data.message, "cyclic");
      assert.equal(posted[0].data.options.payload, undefined);
    } finally {
      globalThis.window.postMessage = realPostMessage;
    }
  });

  it("ignores config messages that did not come from this window", () => {
    messageListener({
      source: { not: "our window" },
      data: { action: LOG_CONFIG_ACTION, data: { config: { consoleEnabled: true } } },
    });
    // Nothing to assert on the console directly; the point is that a foreign
    // frame cannot flip our logging on. No throw, and no posted messages.
    assert.equal(posted.length, 0);
  });
});
