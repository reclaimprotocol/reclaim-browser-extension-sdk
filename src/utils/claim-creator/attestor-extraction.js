/**
 * The attestor's response-redaction chain, adapted to return extracted values
 * instead of reveal ranges.
 *
 * Mirrors `processRedactionRequest` in attestor-core
 * `src/providers/http/index.ts` (a private generator, so it can't be vendored
 * verbatim like ./vendor/attestor-http-utils.js). Keep the traversal order and
 * offset arithmetic identical to upstream: `xPath` first, then `jsonPath`
 * *within the element the xPath selected*, then `regex` within that. Getting
 * the order or the offsets wrong yields a value that looks right but does not
 * match the byte range the attestor reveals, and the claim then fails at the
 * attestor with no useful error.
 */

import {
  extractHTMLElementsIndexes,
  extractJSONValueIndexes,
  makeRegex,
} from "./vendor/attestor-http-utils.js";

export { makeRegex };

/**
 * A redaction that does not resolve against this particular response body.
 * Distinct from a genuine error: it usually means the page hasn't rendered the
 * data yet, so the caller should keep looking rather than fail the session.
 */
export class RedactionResolveError extends Error {
  /**
   * @param {string} message - selectors and shape only. MUST NOT embed response
   *   content: this message becomes a `logLine` and is POSTed to the diagnostic
   *   endpoint, where the user's authenticated page content has no business
   *   being. Pass it as `element` instead — callers route that through the log
   *   payload, which the console renders in full and the endpoint gets redacted.
   * @param {object} [details]
   * @param {"xPath"|"jsonPath"|"regex"|"redaction"} [details.stage] - which link
   *   of the xPath -> jsonPath -> regex chain gave up. Lets the caller report
   *   the specific failure (X_PATH_MATCH_REQUIREMENT_FAILED, …) instead of one
   *   undifferentiated "did not resolve".
   * @param {string} [details.element] - the content the stage was looking at.
   */
  constructor(message, { stage = "redaction", element } = {}) {
    super(message);
    this.name = "RedactionResolveError";
    this.retryable = true;
    this.stage = stage;
    this.element = element;
  }
}

/**
 * Resolve one responseRedaction against a response body, following the
 * attestor's xPath -> jsonPath -> regex chain.
 *
 * @param {string} body - full response body
 * @param {{xPath?: string, jsonPath?: string, regex?: string, hash?: string}} rs
 * @returns {{value: string, start: number, end: number}[]} one entry per match,
 *  in upstream's yield order. For a hashed regex redaction the entry is the
 *  named capture group only — that is the span the attestor hashes and reveals.
 * @throws {RedactionResolveError} if the redaction does not resolve
 */
export function resolveRedaction(body, rs) {
  const out = [];

  let element = body;
  let elementIdx = 0;
  let elementLength = -1;
  // Which link of the chain we are on, so a throw from the vendored extractors
  // (which know nothing about this) can still be attributed to a stage.
  let stage = "redaction";

  try {
    if (rs.xPath) {
      stage = "xPath";
      const indexes = extractHTMLElementsIndexes(body, rs.xPath, !!rs.jsonPath);
      for (const { start, end } of indexes) {
        element = body.slice(start, end);
        elementIdx = start;
        elementLength = end - start;
        if (rs.jsonPath) {
          processJsonPath();
        } else if (rs.regex) {
          processRegexp();
        } else {
          emit();
        }
      }
    } else if (rs.jsonPath) {
      processJsonPath();
    } else if (rs.regex) {
      processRegexp();
    } else {
      throw new Error("Expected either xPath, jsonPath or regex for redaction");
    }
  } catch (error) {
    if (error instanceof RedactionResolveError) {
      throw error;
    }
    throw new RedactionResolveError(error?.message || String(error), { stage });
  }

  if (!out.length) {
    throw new RedactionResolveError(`Redaction resolved to nothing (${describeRedaction(rs)})`, {
      stage,
    });
  }

  return out;

  function processJsonPath() {
    stage = "jsonPath";
    const jsonPathIndexes = extractJSONValueIndexes(element, rs.jsonPath);

    const eIndex = elementIdx;
    for (const ji of jsonPathIndexes) {
      const jStart = ji.start;
      const jEnd = ji.end;
      element = body.slice(eIndex + jStart, eIndex + jEnd);
      elementIdx = eIndex + jStart;
      elementLength = jEnd - jStart;

      if (rs.regex) {
        processRegexp();
      } else {
        emit();
      }
    }
  }

  function processRegexp() {
    stage = "regex";
    const regexp = makeRegex(rs.regex);
    const elem = element || body;
    const match = regexp.exec(elem);

    if (!match?.[0]) {
      // The element text used to be interpolated into this message, which put up
      // to 200 characters of the user's authenticated page into every log line
      // shipped to the diagnostic endpoint. It travels as `element` now, so the
      // caller can give it to the console without publishing it.
      throw new RedactionResolveError(
        `regexp ${rs.regex} does not match the selected element (element length: ${elem.length})`,
        { stage: "regex", element: elem },
      );
    }

    elementIdx += match.index;
    elementLength = regexp.lastIndex - match.index;
    element = match[0];

    if (rs.hash && (!match.groups || Object.keys(match.groups).length > 1)) {
      throw new Error("Exactly one named capture group is needed per hashed redaction");
    }

    // if there are groups in the regex, we'll only reveal the group values
    if (!rs.hash || !match.groups) {
      emit();
      return;
    }

    // A hashed redaction reveals only the capture group, so that — not the
    // whole regex match — is the value that has to land in paramValues.
    const fullStr = match[0];
    const grp = Object.values(match.groups)[0];
    const grpIdx = fullStr.indexOf(grp);

    elementIdx += grpIdx;
    element = grp;
    elementLength = grp.length;
    emit();
  }

  function emit() {
    if (elementIdx < 0 || !elementLength) {
      return;
    }
    out.push({
      value: element,
      start: elementIdx,
      end: elementIdx + elementLength,
    });
  }
}

/** First resolved slice, or throw. */
export function resolveRedactionFirst(body, rs) {
  return resolveRedaction(body, rs)[0];
}

export function describeRedaction(rs) {
  const parts = [];
  if (rs.xPath) parts.push(`xPath: ${rs.xPath}`);
  if (rs.jsonPath) parts.push(`jsonPath: ${rs.jsonPath}`);
  if (rs.regex) parts.push(`regex: ${rs.regex}`);
  return parts.join(", ") || "empty redaction";
}

// `truncate()` lived here to cap response content spliced into an error
// message. Nothing embeds response content in a message any more — it travels as
// RedactionResolveError.element and is capped by the log layer on its way to the
// endpoint — so the helper is gone rather than left as an invitation.
