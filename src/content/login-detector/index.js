import { runLoginProbe } from "./register";
import "./login_script.js";

export const LOGIN_CHECK_INTERVAL_MS = 2500;

/**
 * Runs the portal's login probe on the top frame: now, on DOMContentLoaded /
 * load, on `notifyUrlChange()`, and every LOGIN_CHECK_INTERVAL_MS. `report`
 * gets `{ indicator, hasPassword }` and returns false to stop probing.
 * Returns `{ stop, notifyUrlChange }`, or null in iframes / about:blank.
 */
export function startLoginDetection(report) {
  if (window.top !== window || window.location.href === "about:blank") return null;
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    const indicator = runLoginProbe();
    if (indicator !== "url" && indicator !== "element" && indicator !== "none") return;
    const hasPassword = !!document.querySelector('input[type="password"]');
    if ((await report({ indicator, hasPassword })) === false) stop();
  };
  const timer = setInterval(check, LOGIN_CHECK_INTERVAL_MS);
  document.addEventListener("DOMContentLoaded", check);
  window.addEventListener("load", check);
  check();
  function stop() {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("DOMContentLoaded", check);
    window.removeEventListener("load", check);
  }
  return { stop, notifyUrlChange: check };
}
