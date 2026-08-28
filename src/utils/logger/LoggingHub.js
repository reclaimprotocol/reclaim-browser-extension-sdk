/**
 * LoggingHub - the single sink for every log the SDK produces.
 *
 * Background logs to it directly; content, offscreen and the MAIN-world
 * interceptor reach it through `handleRemoteLog` (see RemoteLogger and the
 * RECLAIM_LOG bridge in content.js). Everything is enriched with one session
 * context, batched, and POSTed to the diagnostic endpoint.
 *
 * ONE threshold, `config.logLevel`, governing both destinations:
 *
 *   INFO (default) — the whole session, values REDACTED. Console (when
 *                    enabled) and the endpoint receive the same redacted text.
 *   FINE           — the whole session, values RAW: response bodies, extracted
 *                    parameters, the full claim and proof. Also sent to the
 *                    endpoint, which is the point — it is how a client's failing
 *                    session is diagnosed remotely, with their permission.
 *
 * `config.consoleEnabled` is independent and only decides whether lines are
 * mirrored to this context's console; it never changes what is collected.
 *
 * The queue is mirrored into `chrome.storage.session` on every change. An MV3
 * service worker is killed without warning and `chrome.runtime.onSuspend` does
 * not reliably fire, so an in-memory-only queue loses exactly the logs that
 * explain a crash. On the next start `_drainPersisted()` picks them back up.
 */

import {
  LOGGING_ENDPOINTS,
  LOG_LEVEL,
  DEFAULT_LOG_CONFIG,
  LOG_CONFIG_STORAGE_KEY,
  LOG_QUEUE_STORAGE_KEY,
  LOG_FLUSH_ALARM_NAME,
  normalizeLogLevel,
} from "./constants.js";
import { getClientSource, withClientSource } from "./client-source.js";
import { redact, redactedJson, unredactedJson } from "./redact.js";
import {
  LOG_MAX_BATCH_SIZE,
  LOG_MAX_QUEUE_SIZE,
  LOG_FLUSH_INTERVAL_MS,
  LOG_DEDUPE_WINDOW_MS,
  LOG_FLUSH_ALARM_PERIOD_MINUTES,
  LOG_MAX_LINE_LENGTH,
  LOG_MAX_UNREDACTED_LINE_LENGTH,
} from "../constants/config.js";

// Singleton guard to prevent multiple instances
let singletonInstance = null;

/**
 * Cap a log line, keeping both ends. The head says what happened and the tail
 * usually holds the error; cutting only the tail loses half of that.
 */
function truncateLine(message, max = LOG_MAX_LINE_LENGTH) {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (text.length <= max) return text;
  const keep = Math.floor((max - 40) / 2);
  return `${text.slice(0, keep)}… [${text.length - keep * 2} chars truncated] …${text.slice(-keep)}`;
}

class LoggingHub {
  constructor() {
    // Return existing instance if already created
    if (singletonInstance) {
      return singletonInstance;
    }

    this.sessionContext = {
      sessionId: null,
      providerId: null,
      appId: null,
    };
    // Set once a terminal path has flushed; the identifiers survive so late
    // logs stay findable. See clearSessionContext().
    this.sessionEnded = false;
    this._contextSetExplicitly = false;
    this._flushChain = null;
    this.logs = [];
    this.deviceId = null;
    this.maxBatchSize = LOG_MAX_BATCH_SIZE;
    this.maxQueueSize = LOG_MAX_QUEUE_SIZE;
    this.flushIntervalMs = LOG_FLUSH_INTERVAL_MS;
    this.flushIntervalId = null;
    this.isFlushing = false;

    // Deduplication: logHash -> { ts, entry }. Keeping the entry reference lets
    // a repeat bump a counter on the queued line instead of vanishing.
    this._recentLogHashes = new Map();
    this._dedupeWindowMs = LOG_DEDUPE_WINDOW_MS;

    // Stats tracking
    this.stats = {
      totalLogsQueued: 0,
      totalLogsSent: 0,
      totalLogsDropped: 0,
      totalDeduplicated: 0,
      totalRestored: 0,
      flushCount: 0,
    };

    // Log config (log level + console output)
    this.config = { ...DEFAULT_LOG_CONFIG };

    // Async init is deferred until this hub is actually used. `background.js`
    // is imported at module scope by `ReclaimExtensionSDK.js`, so constructing
    // the hub eagerly would start a flush schedule in every consumer popup and
    // web page that only ever calls the public API. `ready` stays a promise
    // from the outside either way.
    this._started = false;
    this.ready = Promise.resolve();

    singletonInstance = this;
  }

  /**
   * Start async init exactly once, on first real use.
   * @returns {Promise<void>}
   */
  _ensureStarted() {
    if (this._started) return this.ready;
    this._started = true;
    this.ready = this._init();
    return this.ready;
  }

  /**
   * Run all async initialization and start the flush schedule
   */
  async _init() {
    await Promise.all([
      this._initDeviceId(),
      this._restoreSessionContext(),
      this._loadConfig(),
      this._drainPersisted(),
    ]);
    this._watchConfigChanges();
    this._startFlushSchedule();
  }

  /**
   * Initialize or retrieve persistent device ID
   */
  async _initDeviceId() {
    try {
      const result = await chrome.storage.local.get("reclaim_device_id");
      if (result.reclaim_device_id) {
        this.deviceId = result.reclaim_device_id;
      } else {
        this.deviceId = `ext-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        await chrome.storage.local.set({ reclaim_device_id: this.deviceId });
      }
    } catch {
      this.deviceId = `ext-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
  }

  /**
   * Restore session context from storage (handles service worker restarts)
   */
  async _restoreSessionContext() {
    try {
      const result = await chrome.storage.session?.get("reclaim_log_session_context");
      // Never clobber a context the caller set while this read was in flight.
      if (result?.reclaim_log_session_context && !this._contextSetExplicitly) {
        this.sessionContext = result.reclaim_log_session_context;
      }
    } catch {
      // chrome.storage.session may not be available, ignore
    }
  }

  /**
   * Recover logs queued by a previous service-worker lifetime.
   *
   * These are prepended: they are older than anything this lifetime has
   * produced, and the endpoint reads the batch in order.
   */
  async _drainPersisted() {
    try {
      const stored = await chrome.storage.session?.get(LOG_QUEUE_STORAGE_KEY);
      const pending = stored?.[LOG_QUEUE_STORAGE_KEY];
      if (Array.isArray(pending) && pending.length > 0) {
        this.logs.unshift(...pending);
        this.stats.totalRestored += pending.length;
        this._trimQueue();
        await chrome.storage.session?.remove(LOG_QUEUE_STORAGE_KEY);
      }
    } catch {
      // chrome.storage.session may not be available.
    }
  }

  /**
   * Mirror the pending queue so a worker teardown does not lose it.
   *
   * Fire-and-forget on purpose: `chrome.storage.session` is in-memory, so this
   * is cheap, and awaiting it would put a storage round-trip in the path of
   * every log call.
   */
  _persistQueue() {
    try {
      if (this.logs.length === 0) {
        chrome.storage.session?.remove(LOG_QUEUE_STORAGE_KEY);
      } else {
        chrome.storage.session?.set({ [LOG_QUEUE_STORAGE_KEY]: this.logs });
      }
    } catch {
      // Storage unavailable — the in-memory queue is still the primary path.
    }
  }

  /**
   * Load log config from storage
   */
  async _loadConfig() {
    try {
      const result = await chrome.storage.local.get(LOG_CONFIG_STORAGE_KEY);
      if (result[LOG_CONFIG_STORAGE_KEY]) {
        this.config = { ...this.config, ...result[LOG_CONFIG_STORAGE_KEY] };
      }
    } catch {
      // Storage may not be available, use defaults
    }
  }

  /**
   * Watch for config changes in storage (live sync)
   */
  _watchConfigChanges() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[LOG_CONFIG_STORAGE_KEY]) {
          const newConfig = changes[LOG_CONFIG_STORAGE_KEY].newValue;
          if (newConfig) {
            this.config = { ...this.config, ...newConfig };
          }
        }
      });
    } catch {
      // Storage may not be available
    }
  }

  /**
   * Force reload config from storage (useful for ensuring sync)
   */
  async reloadConfig() {
    await this._loadConfig();
  }

  /**
   * Set log config programmatically
   * @param {Object} config - Partial config to merge
   */
  setConfig(config) {
    this.config = { ...this.config, ...config };
    try {
      chrome.storage.local.set({ [LOG_CONFIG_STORAGE_KEY]: this.config });
    } catch {
      // Storage may not be available
    }
  }

  /**
   * Compare a level against a threshold. Lower number = higher severity.
   * @param {string} level - Log level of the entry
   * @param {string} threshold - Configured threshold name
   * @returns {boolean}
   */
  _passes(level, threshold) {
    const max = LOG_LEVEL[normalizeLogLevel(threshold)] || LOG_LEVEL.INFO;
    const requested = LOG_LEVEL[normalizeLogLevel(level)] || LOG_LEVEL.INFO;
    return requested <= max;
  }

  /**
   * Whether this level is emitted at all.
   *
   * One threshold, both destinations. There is deliberately no separate remote
   * threshold: two of them meant the console and the endpoint could disagree
   * about what a session contained, and the remote one defaulted to the most
   * verbose level, so everything shipped regardless of what the console showed.
   *
   * @param {string} level
   * @returns {boolean}
   */
  _passesThreshold(level) {
    return this._passes(level, this.config.logLevel);
  }

  /**
   * Whether payloads are serialised raw rather than redacted.
   *
   * True only at FINE. This is the single switch between "everything about the
   * session, values blanked" and "everything about the session, values intact",
   * and it governs the console and the endpoint alike.
   *
   * @returns {boolean}
   */
  _isRaw() {
    return normalizeLogLevel(this.config.logLevel) === "FINE";
  }

  /**
   * Start the periodic flush.
   *
   * `chrome.alarms` is preferred and used when the consumer's manifest grants
   * the permission: a `setInterval` is destroyed along with the service worker,
   * which is precisely when a flush is most needed. The interval remains as the
   * fallback so no consumer manifest change is required.
   */
  _startFlushSchedule() {
    const alarms = globalThis.chrome?.alarms;
    if (alarms?.create) {
      try {
        alarms.create(LOG_FLUSH_ALARM_NAME, {
          periodInMinutes: LOG_FLUSH_ALARM_PERIOD_MINUTES,
        });
        alarms.onAlarm.addListener((alarm) => {
          if (alarm?.name === LOG_FLUSH_ALARM_NAME) this.flush();
        });
        this._usingAlarms = true;
      } catch {
        this._usingAlarms = false;
      }
    }

    if (!this._usingAlarms) {
      if (this.flushIntervalId) clearInterval(this.flushIntervalId);
      this.flushIntervalId = setInterval(() => this.flush(), this.flushIntervalMs);
    }

    // Best-effort backstop. Not load-bearing: onSuspend often never fires.
    try {
      chrome.runtime.onSuspend?.addListener(() => {
        this.flush();
      });
    } catch {
      // onSuspend may not be available
    }
  }

  /**
   * Set session context - called when verification starts
   * @param {Object} context
   * @param {string} context.sessionId
   * @param {string} context.providerId
   * @param {string} context.appId
   */
  setSessionContext({ sessionId, providerId, appId }) {
    this._ensureStarted();
    this.sessionContext = {
      sessionId: sessionId || null,
      providerId: providerId || null,
      appId: appId || null,
    };
    this.sessionEnded = false;
    // `_init()` runs `_restoreSessionContext()` asynchronously. A caller that
    // sets the context on a cold worker would otherwise have it overwritten by
    // the previous session's persisted value a few microtasks later, silently
    // filing this session's logs under the old id.
    this._contextSetExplicitly = true;

    // Persist to chrome.storage.session for service worker restart recovery
    try {
      chrome.storage.session?.set({
        reclaim_log_session_context: this.sessionContext,
      });
    } catch {
      // chrome.storage.session may not be available
    }
  }

  /**
   * Clear session context - called when session ends or fails.
   *
   * Flushes first: entries already queued carry the session's identifiers, and
   * a terminal event is exactly the point at which the worker is likely to be
   * torn down. Without this the last and most diagnostic logs of a failed
   * session are the ones most likely to be lost.
   * @returns {Promise<void>}
   */
  async clearSessionContext() {
    await this.forceFlush();

    // The identifiers are deliberately KEPT. A terminal path is not the last
    // thing that logs: failSession() calls this and the flow then goes on to
    // notify tabs, broadcast to the popup and answer further messages. Nulling
    // the ids here stamped all of that "unknown", which does not merely lose
    // attribution — it makes those lines unreachable from a `sessionId` query,
    // i.e. invisible in exactly the view used to debug the failure.
    //
    // The cost is that a stray log emitted between two verifications is
    // attributed to the finished session. That window is small (the next
    // startVerification calls setSessionContext) and a slightly over-attributed
    // line is far cheaper than a missing one.
    this.sessionEnded = true;
  }

  /**
   * Drop oldest logs if the queue exceeds its cap (prevents OOM on API outage)
   */
  _trimQueue() {
    if (this.logs.length > this.maxQueueSize) {
      const dropped = this.logs.length - this.maxQueueSize;
      this.logs = this.logs.slice(dropped);
      this.stats.totalLogsDropped += dropped;
    }
  }

  /**
   * Internal method to add a log entry.
   *
   * Redaction follows the LEVEL, not the destination. One threshold decides
   * both what is emitted and in what form, and the console and the endpoint
   * then receive the same information:
   *
   *   logLevel INFO (default) -> `payload` is REDACTED. Values are blanked,
   *                              key names kept, and the line is capped at
   *                              LOG_MAX_LINE_LENGTH.
   *   logLevel FINE           -> `payload` is RAW, capped at
   *                              LOG_MAX_UNREDACTED_LINE_LENGTH so a real claim
   *                              is not cut in half.
   *
   * The console gets the payload as a live object so devtools renders a tree;
   * at INFO it is a redacted *copy*, so turning the console on never reveals
   * more than the endpoint already holds.
   *
   * This replaced a destination-based split (console raw / endpoint redacted)
   * plus a per-call `unredacted` opt-out. That arrangement could not express
   * "no user data anywhere by default", because it left the console showing
   * response bodies and extracted values at the default level.
   *
   * @param {string} message - Log message. MUST NOT embed user data: redaction
   *   cannot reach inside a string that was already concatenated at the call
   *   site. Pass structured data as `payload` instead.
   * @param {string} type - Log type/category
   * @param {string} level - "SEVERE" | "WARNING" | "INFO" | "FINE" (older
   *   spellings ERROR/WARN/DEBUG are accepted and normalized)
   * @param {string} [context] - Emitting context: background | content | offscreen | interceptor
   * @param {Object} [options]
   * @param {string} [options.eventType] - A value from EVENT_TYPES. This is the
   *   cross-SDK lifecycle name; `type` is the dotted category used for
   *   filtering. Both are useful: `eventType` answers "where in the flow", the
   *   category answers "which module".
   * @param {*} [options.payload] - Structured data. Pass the OBJECT, never a
   *   pre-stringified blob: stringifying at the call site defeats redaction and
   *   sends whatever it contains straight to the endpoint.
   */
  _addLog(message, type, level = "INFO", context = "background", options = undefined) {
    this._ensureStarted();

    const resolvedLevel = normalizeLogLevel(level);
    const { eventType, payload } = options || {};

    if (!this._passesThreshold(resolvedLevel)) {
      return;
    }

    // Raw values only exist at FINE. At every other level the payload is
    // redacted once, here, and that same redacted copy is what both the console
    // and the endpoint see.
    const raw = this._isRaw();
    const hasPayload = payload !== undefined;
    const consolePayload = hasPayload ? (raw ? payload : redact(payload)) : undefined;

    // Console output if enabled. The context is included so a service-worker
    // console shows at a glance whether a line came from background, content or
    // offscreen — remote logs are relayed through this same path.
    if (this.config.consoleEnabled) {
      const consoleFn =
        resolvedLevel === "SEVERE"
          ? console.error
          : resolvedLevel === "WARNING"
            ? console.warn
            : console.log;
      // Literal format string, `message` passed as an argument — see the note
      // in log-bridge.js. A message carrying "%s" otherwise consumes the
      // payload and corrupts the line.
      const format = type ? "[%s] [%s] [%s] %s" : "[%s] [%s] %s";
      const parts = type
        ? [resolvedLevel, context, type, message]
        : [resolvedLevel, context, message];
      if (hasPayload) {
        consoleFn(format, ...parts, consolePayload);
      } else {
        consoleFn(format, ...parts);
      }
    }

    const line = hasPayload
      ? raw
        ? truncateLine(`${message} ${unredactedJson(payload)}`, LOG_MAX_UNREDACTED_LINE_LENGTH)
        : truncateLine(`${message} ${redactedJson(payload)}`)
      : truncateLine(message);
    const now = Date.now();

    // Deduplication guards against a tight loop flooding the batch. Keyed on
    // context and level too: the same wording emitted from background and from
    // offscreen (or at INFO and then at ERROR) are different events, and
    // collapsing them loses the one that matters. A repeat within the window
    // increments `repeated` on the queued entry rather than disappearing, so
    // the count is still visible downstream.
    const logHash = `${context}|${resolvedLevel}|${line}|${type}|${eventType || ""}`;
    const seen = this._recentLogHashes.get(logHash);
    if (seen !== undefined && now - seen.ts < this._dedupeWindowMs) {
      this.stats.totalDeduplicated++;
      if (seen.entry) {
        seen.entry.repeated = (seen.entry.repeated || 1) + 1;
      }
      return;
    }

    const entry = {
      logLine: line,
      ts: String(now * 1000000), // nanoseconds for Loki
      // Canonical platform spelling (SEVERE/WARNING/INFO/FINE) so the log
      // viewer's severity filter covers extension sessions too.
      logLevel: resolvedLevel,
      type: type || "unknown",
      // Cross-SDK lifecycle name (EVENT_TYPES), spelled the same as the InApp
      // SDK's LogEventType so one query spans both. UNKNOWN, not omitted, so
      // the field is always present for a Loki label.
      eventType: eventType || "UNKNOWN",
      // Which extension context emitted this: background | content | offscreen
      // | interceptor. Distinct from `source`, which identifies the SDK build.
      context,
      // Versioned SDK identity on every entry, not just the batch envelope, so
      // a single line lifted out of Loki is still attributable.
      source: getClientSource(),
      sessionId: this.sessionContext.sessionId || "unknown",
      providerId: this.sessionContext.providerId || "unknown",
      appId: this.sessionContext.appId || "unknown",
      deviceId: this.deviceId || "unknown",
    };

    this._recentLogHashes.set(logHash, { ts: now, entry });

    // Periodically prune stale entries from the dedup map (every 100 entries)
    if (this._recentLogHashes.size > 100) {
      for (const [key, value] of this._recentLogHashes) {
        if (now - value.ts >= this._dedupeWindowMs) {
          this._recentLogHashes.delete(key);
        }
      }
    }

    this.logs.push(entry);
    this.stats.totalLogsQueued++;
    this._trimQueue();
    this._persistQueue();

    if (this.logs.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  // Public API - consistent across all loggers

  /**
   * Log an error message (highest severity - always logged)
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  error(message, type, options) {
    this._addLog(message, type, "SEVERE", "background", options);
  }

  /**
   * Log a warning message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  warn(message, type, options) {
    this._addLog(message, type, "WARNING", "background", options);
  }

  /**
   * Log an info message
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  info(message, type, options) {
    this._addLog(message, type, "INFO", "background", options);
  }

  /**
   * Log at FINE — emitted only when `logLevel` is FINE, and that is also the
   * level at which payloads are serialised raw. Use it for the detail that only
   * matters while actively debugging a session.
   *
   * `debug()` is kept as the name because every existing call site uses it.
   *
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {Object} [options] - `{ eventType, payload }`; see _addLog
   */
  debug(message, type, options) {
    this._addLog(message, type, "FINE", "background", options);
  }

  /** @see debug - alias spelled the way the platform spells the level. */
  fine(message, type, options) {
    this._addLog(message, type, "FINE", "background", options);
  }

  /**
   * Handle a log relayed from another context (content / offscreen /
   * interceptor). Called by the message router on LOG_MESSAGE.
   *
   * A relayed log appears in two consoles by design: its own context's (from
   * RemoteLogger) and the service worker's (from `_addLog` below), the latter
   * labelled with the originating context so a multi-context flow reads in one
   * place. `payload` survives chrome messaging as a structured clone, so the
   * level-based redaction applies to it here exactly as it would to a
   * background log.
   *
   * @param {string} message - Log message
   * @param {string} type - Log type/category
   * @param {string} level - "SEVERE" | "WARNING" | "INFO" | "FINE"
   * @param {string} [context] - Originating context
   * @param {Object} [options] - `{ eventType, payload }` forwarded from that context
   */
  handleRemoteLog(message, type, level = "INFO", context = "remote", options = undefined) {
    this._addLog(message, type, level, context, options);
  }

  /**
   * Flush logs to the external API.
   *
   * Calls are SERIALIZED, never skipped. Returning early while another flush is
   * in flight loses the caller's batch: the periodic flush and the terminal
   * `clearSessionContext()` regularly overlap, and dropping the terminal one
   * silently discards the end of a failed session — which is the part that
   * explains the failure. Each call therefore chains onto the previous one and
   * flushes whatever is queued when its turn comes.
   *
   * @returns {Promise<void>} resolves once THIS call's batch has been attempted
   */
  flush() {
    this._flushChain = (this._flushChain || Promise.resolve())
      .then(() => this._flushOnce())
      // A rejection must not poison the chain for every later flush.
      .catch(() => {});
    return this._flushChain;
  }

  /**
   * POST one batch. Only ever called from the `flush()` chain, so it never runs
   * concurrently with itself.
   */
  async _flushOnce() {
    if (this.logs.length === 0) {
      return;
    }

    this.isFlushing = true;
    const batch = this.logs.splice(0, this.logs.length);
    const batchSize = batch.length;
    // The queue is empty as far as storage is concerned; if the POST fails the
    // batch goes back and is re-persisted below.
    this._persistQueue();

    try {
      const response = await fetch(LOGGING_ENDPOINTS.DIAGNOSTIC_LOGGING, {
        method: "POST",
        headers: withClientSource({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          logs: batch,
          source: getClientSource(),
          deviceId: this.deviceId || "unknown",
        }),
      });

      if (!response.ok) {
        // Re-queue failed logs (prepend to maintain order)
        this.logs.unshift(...batch);
        this._trimQueue();
        this._persistQueue();
        if (this.config.consoleEnabled) {
          console.error("[LoggingHub] Failed to flush logs:", response.status);
        }
      } else {
        this.stats.totalLogsSent += batchSize;
        this.stats.flushCount++;
      }
    } catch (error) {
      // Re-queue failed logs
      this.logs.unshift(...batch);
      this._trimQueue();
      this._persistQueue();
      if (this.config.consoleEnabled) {
        console.error("[LoggingHub] Error flushing logs:", error);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Flush now and wait for it.
   *
   * Kept as a distinct name because terminal paths read better with it, but
   * `flush()` is already serialized and awaitable, so this is simply it. The
   * previous implementation polled `isFlushing` for one second and then called
   * `flush()` anyway — which no-opped if the in-flight request was still going,
   * so the terminal batch was dropped exactly when it mattered most.
   */
  async forceFlush() {
    await this.flush();
  }

  /**
   * Get logging statistics
   * @returns {Object} Stats object with counts
   */
  getStats() {
    return {
      ...this.stats,
      pendingLogs: this.logs.length,
      sessionId: this.sessionContext.sessionId,
      source: getClientSource(),
    };
  }

  /**
   * Cleanup - stop the schedule and flush remaining logs
   */
  async destroy() {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
    try {
      globalThis.chrome?.alarms?.clear?.(LOG_FLUSH_ALARM_NAME);
    } catch {
      // alarms may not be available
    }
    await this.flush();
  }
}

// Export singleton instance for background use
export const loggingHub = new LoggingHub();

// Export class and helpers for testing
export { LoggingHub, truncateLine };
