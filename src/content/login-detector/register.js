// login_script.js registers its probe via `window.Reclaim._setLoginCheck(fn)`
// (the portal's runtime hook). This content script is its own runtime: it
// provides that hook in the isolated world (invisible to the page) so the
// portal file can stay verbatim. Must be imported before ./login_script.js.
let probe = null;
globalThis.Reclaim ||= {};
globalThis.Reclaim._setLoginCheck = (fn) => {
  probe = fn;
};

/** Returns 'url' | 'element' | 'none' (or false if the probe threw). */
export function runLoginProbe() {
  return probe ? probe() : false;
}
