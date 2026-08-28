/**
 * Session-wide claim progress for the in-page popup.
 *
 * The popup cannot count this itself. It lives in the content script, which is
 * destroyed and rebuilt at `document_start` on every navigation — and a
 * multi-request provider routinely spans several origins (the `example`
 * provider walks example.org -> example.com -> jsonplaceholder). Each new page
 * got a popup with `totalClaims: 0` that then counted only the events arriving
 * after it was built, so a real 3-claim session displayed `1/1`, flashed `2/1`,
 * and finished by printing `totalClaims/totalClaims` — `1/1` again.
 *
 * The background is the only context that survives those navigations, so it is
 * the only place these numbers are real. It sends them with
 * CLAIM_CREATION_REQUESTED and PROOF_GENERATION_SUCCESS.
 *
 * Its own module rather than a function in background.js so it is reachable
 * from `node --test`: background.js uses extensionless imports, which webpack
 * resolves and Node's ESM loader does not.
 *
 * @param {{generatedProofs?: Map<string, unknown>, providerData?: {requestData?: unknown[]}}} ctx
 * @returns {{completed: number, total: number}}
 */
export function claimProgress(ctx) {
  const completed = ctx?.generatedProofs?.size ?? 0;
  const declared = Array.isArray(ctx?.providerData?.requestData)
    ? ctx.providerData.requestData.length
    : 0;
  // `total` takes the larger of the two: with `expectManyClaims` a provider
  // script can produce more claims than `requestData` declares, and a counter
  // that reads `4/3` is worse than one that grows.
  return { completed, total: Math.max(declared, completed) };
}
