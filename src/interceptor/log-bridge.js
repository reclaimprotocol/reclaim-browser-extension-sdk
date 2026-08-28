/**
 * Log bridge for MAIN-world scripts.
 *
 * The network interceptor and the injection scripts run in the page's own
 * JavaScript world. There is no `chrome.runtime` there, so until this bridge
 * existed their diagnostics went to `console` and nowhere else: never to the
 * endpoint, and never gated by the SDK's log config. That is the most
 * failure-prone stage of the whole flow — request interception — logging into a
 * void.
 *
 * The bridge posts each line to the content script (`RECLAIM_LOG`), which
 * relays it to the LoggingHub like any other context. Console mirroring is
 * gated by a config the content script pushes down with `RECLAIM_LOG_CONFIG`,
 * since the page world cannot read `chrome.storage` itself.
 *
 * Defaults are permissive on purpose: a log emitted before the first config
 * push should still be visible, and `document_start` injection means the very
 * first lines arrive before anything else is ready.
 */

const LOG_ACTION = "RECLAIM_LOG";
const LOG_CONFIG_ACTION = "RECLAIM_LOG_CONFIG";

// Mirrors LOG_LEVEL / the alias table in src/utils/logger/constants.js. Kept as
// a literal for the same dependency-free reason as `config` below; the old
// ERROR/WARN/DEBUG spellings are ranked too so a stale config push (or an older
// content script) still resolves to something sensible.
const LEVEL_RANK = {
  SEVERE: 1,
  ERROR: 1,
  WARNING: 2,
  WARN: 2,
  INFO: 3,
  CONFIG: 3,
  FINE: 4,
  DEBUG: 4,
};

// Must match DEFAULT_LOG_CONFIG in src/utils/logger/constants.js. Not imported
// from there on purpose: these scripts are injected into the page's own world
// at document_start and stay dependency-free. Defaulting the console OFF is the
// safe direction — this runs inside the provider's page, so being wrong the
// other way narrates the verification in the end user's devtools until the
// content script's config push lands. Forwarding to the hub is unconditional
// either way, so nothing is lost from the diagnostic dump.
let config = { consoleEnabled: false, logLevel: "INFO" };
let listening = false;

/**
 * Listen for config pushed down by the content script. Installed once, lazily,
 * so importing this module has no side effect until a logger is created.
 */
function ensureConfigListener() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  try {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.action === LOG_CONFIG_ACTION && data.data?.config) {
        config = { ...config, ...data.data.config };
      }
    });
  } catch {
    // A hostile page may have tampered with addEventListener; keep defaults.
  }
}

function shouldConsole(level) {
  if (!config.consoleEnabled) return false;
  const threshold = LEVEL_RANK[config.logLevel] || LEVEL_RANK.INFO;
  return (LEVEL_RANK[level] || LEVEL_RANK.INFO) <= threshold;
}

/**
 * Split console-style args into a message string and a structured payload.
 *
 * Strings and Errors go into the message: they are safe to store verbatim and
 * an Error reads better as `TypeError: bad input` than as `{}` (Error fields
 * are non-enumerable, so JSON.stringify yields nothing useful).
 *
 * Anything else — a plain object, an array — becomes `payload` and is sent as a
 * live object rather than stringified here. That matters: the hub redacts the
 * payload on the way to the endpoint while both consoles show real values. If
 * this function stringified objects into the message instead, a caller logging
 * a response body would push it straight past redaction to Loki.
 *
 * @returns {{message: string, payload: *}}
 */
function split(args) {
  const words = [];
  const objects = [];

  for (const arg of args) {
    if (typeof arg === "string") {
      words.push(arg);
    } else if (arg instanceof Error) {
      words.push(`${arg.name}: ${arg.message}`);
    } else if (arg !== null && typeof arg === "object") {
      objects.push(arg);
    } else {
      words.push(String(arg));
    }
  }

  return {
    message: words.join(" "),
    payload: objects.length === 0 ? undefined : objects.length === 1 ? objects[0] : objects,
  };
}

/**
 * Create a logger for a MAIN-world script.
 *
 * The returned object keeps the `log`/`info`/`error` shape the interceptor
 * already used, so call sites did not have to change, and adds `warn`/`debug`.
 *
 * @param {string} context - "interceptor" | "injection"
 * @param {string} category - dotted log category, e.g. "interceptor.network"
 * @returns {{log: Function, info: Function, warn: Function, error: Function, debug: Function}}
 */
export function createPageLogger(context, category) {
  ensureConfigListener();

  const emit = (level, args, eventType) => {
    const { message, payload } = split(args);

    if (shouldConsole(level)) {
      const fn =
        level === "SEVERE" ? console.error : level === "WARNING" ? console.warn : console.log;
      // The format string is a literal and `message` is an ARGUMENT, never
      // interpolated into it. `message` is built from page-world content, and
      // the console parses %s/%c/%o in its first argument: a message
      // containing "%s" swallowed the payload and spliced it into the middle
      // of the text, and "%c" let a page inject CSS into its own console.
      // Substituted arguments are not re-parsed, so this closes both.
      if (payload !== undefined) {
        fn("[%s] [%s] %s", level, context, message, payload);
      } else {
        fn("[%s] [%s] %s", level, context, message);
      }
    }

    const post = (data) => window.postMessage({ action: LOG_ACTION, data }, "*");

    try {
      post({ message, type: category, level, context, options: { eventType, payload } });
    } catch {
      // postMessage structured-clones, so a payload holding a function, a DOM
      // node or a cycle throws. Retry without it: losing the detail beats
      // losing the log line that says something went wrong.
      try {
        post({ message, type: category, level, context, options: { eventType } });
      } catch {
        // Nothing left to try.
      }
    }
  };

  return {
    log: (...args) => emit("FINE", args),
    debug: (...args) => emit("FINE", args),
    fine: (...args) => emit("FINE", args),
    info: (...args) => emit("INFO", args),
    warn: (...args) => emit("WARNING", args),
    error: (...args) => emit("SEVERE", args),
    /**
     * Log a named lifecycle event (a value from EVENT_TYPES). Kept separate
     * from the level methods so the variadic console-style signature above
     * stays unchanged for the interceptor's existing call sites.
     */
    event: (eventType, ...args) => emit("INFO", args, eventType),
  };
}

export { LOG_ACTION, LOG_CONFIG_ACTION };
