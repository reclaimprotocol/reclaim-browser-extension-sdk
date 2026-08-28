/**
 * The attestor's regex constructor.
 *
 * Upstream (attestor-core src/providers/http/utils.ts) is `RE2(str, 'sgiu')`,
 * but in a browser the attestor aliases `re2` to
 * src/scripts/fallbacks/re2.ts — `new RegExp(pattern, flags.replace('u',''))` —
 * so `sgi` is what the attestor actually evaluates provider regexes with in
 * this environment. RE2 is not an option here regardless: webpack.config.js
 * aliases `re2: false`.
 *
 * This lives in its own module, separate from ./vendor/attestor-http-utils.js,
 * so the content script can share the attestor's regex flags without pulling
 * xpath/parse5/esprima into a bundle that is injected at document_start on
 * every page of every site.
 *
 * The flags matter: the previous code built flagless `new RegExp(pattern)`, so
 * any provider regex relying on `s` (dot matches newline) or `i` behaved
 * differently here than at the attestor.
 *
 * @param {string} str
 * @returns {RegExp}
 */
export function makeRegex(str) {
  return new RegExp(str, "sgi");
}
