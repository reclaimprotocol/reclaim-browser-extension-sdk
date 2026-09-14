/**
 * How a claimant-facing surface shows a session id.
 *
 * Trims only what is displayed. The full id stays available for copying — the
 * verification popup keeps it in `data-full-value` — so support can still be
 * given the whole thing.
 */

/** How many leading characters of a session id a claimant sees. */
export const SHORT_SESSION_ID_LENGTH = 10;

/**
 * A session id shortened for display.
 *
 * A full id is a 36-character UUID that means nothing to a claimant and
 * crowds the popup row. The leading characters are enough to read one back.
 */
export function shortSessionId(sessionId) {
  if (typeof sessionId !== "string") return "";
  if (sessionId.length <= SHORT_SESSION_ID_LENGTH) return sessionId;
  return `${sessionId.substring(0, SHORT_SESSION_ID_LENGTH)}…`;
}
