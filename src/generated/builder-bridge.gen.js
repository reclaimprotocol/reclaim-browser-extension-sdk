// src/generated/builder-bridge/types.gen.ts
var ClientVerificationEvent = {
  VERIFICATION_CLIENT_OPENED: "verification_client_opened",
  VERIFICATION_CLIENT_READY: "verification_client_ready",
  VERIFICATION_CLIENT_WARNING: "verification_client_warning",
  VERIFICATION_CLIENT_VISIBILITY_SHOWN: "verification_client_visibility_shown",
  VERIFICATION_CLIENT_VISIBILITY_HIDDEN: "verification_client_visibility_hidden",
  VERIFICATION_DIAGNOSTICS_MODE_CHANGED: "verification_diagnostics_mode_changed",
  VERIFICATION_CANCELLED: "verification_cancelled",
  CONSENT_VIEWED: "consent_viewed",
  CONSENT_SCROLLED: "consent_scrolled",
  CONSENT_AGREED: "consent_agreed",
  VERIFICATION_BROWSER_STARTED: "verification_browser_started",
  VERIFICATION_BROWSER_READY: "verification_browser_ready",
  VERIFICATION_BROWSER_RECONNECT_STARTED: "verification_browser_reconnect_started",
  VERIFICATION_BROWSER_RECONNECTED: "verification_browser_reconnected",
  VERIFICATION_BROWSER_FAILED: "verification_browser_failed",
  VERIFICATION_PROVIDER_STARTED: "verification_provider_started",
  PROVIDER_CONFIG: "provider_config",
  PROVIDER_SCRIPT_LOG: "provider_script_log",
  NETWORK_REQUEST_OBSERVED: "network_request_observed",
  VERIFICATION_PAGE_READY: "verification_page_ready",
  VERIFICATION_REQUEST_INTERCEPTOR_READY: "verification_request_interceptor_ready",
  VERIFICATION_PROVIDER_COMPLETED: "verification_provider_completed",
  AUTH_REQUIRED: "auth_required",
  AUTH_SUBMITTED: "auth_submitted",
  AUTH_CHALLENGE_REMAINS: "auth_challenge_remains",
  AUTH_REJECTED: "auth_rejected",
  AUTH_SUBMISSION_FAILED: "auth_submission_failed",
  AUTH_CHALLENGE_COMPLETED: "auth_challenge_completed",
  AUTH_GATE_NOT_DETECTED: "auth_gate_not_detected",
  AUTHENTICATED: "authenticated",
  USER_INTERACTION_STARTED: "user_interaction_started",
  USER_INPUT_STARTED: "user_input_started",
  USER_INTERACTION_SUMMARY: "user_interaction_summary",
  VERIFICATION_INACTIVITY_DETECTED: "verification_inactivity_detected",
  REQUEST_MATCHED: "request_matched",
  REQUEST_MATCH_FAILED: "request_match_failed",
  REQUEST_CLAIM_PARAMETERS_CAPTURED: "request_claim_parameters_captured",
  REQUEST_CLAIM_CREATED: "request_claim_created",
  REQUEST_CLAIM_RETRYING: "request_claim_retrying",
  REQUEST_CLAIM_COMPLETED: "request_claim_completed",
  REQUEST_CLAIM_REJECTED: "request_claim_rejected",
  REQUEST_CLAIM_FAILED: "request_claim_failed",
  VERIFICATION_PROOFS_COMPLETED: "verification_proofs_completed",
  VERIFICATION_RESULT_SUBMITTING: "verification_result_submitting",
  VERIFICATION_RESULT_SUBMISSION_FAILED: "verification_result_submission_failed",
  VERIFICATION_SUCCESS: "verification_success",
  VERIFICATION_REJECTED: "verification_rejected",
  VERIFICATION_ERROR: "verification_error"
};
var ServerVerificationEvent = {
  BILLING_REQUIRED: "billing_required",
  SESSION_PENDING: "session_pending",
  SESSION_EXPIRED: "session_expired"
};

// node_modules/@hey-api/client-fetch/dist/index.js
var A = async (s, r) => {
  let e = typeof r == "function" ? await r(s) : r;
  if (e) return s.scheme === "bearer" ? `Bearer ${e}` : s.scheme === "basic" ? `Basic ${btoa(e)}` : e;
};
var O = { bodySerializer: (s) => JSON.stringify(s, (r, e) => typeof e == "bigint" ? e.toString() : e) };
var U = { $body_: "body", $headers_: "headers", $path_: "path", $query_: "query" };
var D = Object.entries(U);
var B = (s) => {
  switch (s) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var N = (s) => {
  switch (s) {
    case "form":
      return ",";
    case "pipeDelimited":
      return "|";
    case "spaceDelimited":
      return "%20";
    default:
      return ",";
  }
};
var Q = (s) => {
  switch (s) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
};
var S = ({ allowReserved: s, explode: r, name: e, style: a, value: i }) => {
  if (!r) {
    let t = (s ? i : i.map((l) => encodeURIComponent(l))).join(N(a));
    switch (a) {
      case "label":
        return `.${t}`;
      case "matrix":
        return `;${e}=${t}`;
      case "simple":
        return t;
      default:
        return `${e}=${t}`;
    }
  }
  let o = B(a), n = i.map((t) => a === "label" || a === "simple" ? s ? t : encodeURIComponent(t) : m({ allowReserved: s, name: e, value: t })).join(o);
  return a === "label" || a === "matrix" ? o + n : n;
};
var m = ({ allowReserved: s, name: r, value: e }) => {
  if (e == null) return "";
  if (typeof e == "object") throw new Error("Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these.");
  return `${r}=${s ? e : encodeURIComponent(e)}`;
};
var q = ({ allowReserved: s, explode: r, name: e, style: a, value: i, valueOnly: o }) => {
  if (i instanceof Date) return o ? i.toISOString() : `${e}=${i.toISOString()}`;
  if (a !== "deepObject" && !r) {
    let l = [];
    Object.entries(i).forEach(([p, d]) => {
      l = [...l, p, s ? d : encodeURIComponent(d)];
    });
    let u = l.join(",");
    switch (a) {
      case "form":
        return `${e}=${u}`;
      case "label":
        return `.${u}`;
      case "matrix":
        return `;${e}=${u}`;
      default:
        return u;
    }
  }
  let n = Q(a), t = Object.entries(i).map(([l, u]) => m({ allowReserved: s, name: a === "deepObject" ? `${e}[${l}]` : l, value: u })).join(n);
  return a === "label" || a === "matrix" ? n + t : t;
};
var J = /\{[^{}]+\}/g;
var M = ({ path: s, url: r }) => {
  let e = r, a = r.match(J);
  if (a) for (let i of a) {
    let o = false, n = i.substring(1, i.length - 1), t = "simple";
    n.endsWith("*") && (o = true, n = n.substring(0, n.length - 1)), n.startsWith(".") ? (n = n.substring(1), t = "label") : n.startsWith(";") && (n = n.substring(1), t = "matrix");
    let l = s[n];
    if (l == null) continue;
    if (Array.isArray(l)) {
      e = e.replace(i, S({ explode: o, name: n, style: t, value: l }));
      continue;
    }
    if (typeof l == "object") {
      e = e.replace(i, q({ explode: o, name: n, style: t, value: l, valueOnly: true }));
      continue;
    }
    if (t === "matrix") {
      e = e.replace(i, `;${m({ name: n, value: l })}`);
      continue;
    }
    let u = encodeURIComponent(t === "label" ? `.${l}` : l);
    e = e.replace(i, u);
  }
  return e;
};
var k = ({ allowReserved: s, array: r, object: e } = {}) => (i) => {
  let o = [];
  if (i && typeof i == "object") for (let n in i) {
    let t = i[n];
    if (t != null) if (Array.isArray(t)) {
      let l = S({ allowReserved: s, explode: true, name: n, style: "form", value: t, ...r });
      l && o.push(l);
    } else if (typeof t == "object") {
      let l = q({ allowReserved: s, explode: true, name: n, style: "deepObject", value: t, ...e });
      l && o.push(l);
    } else {
      let l = m({ allowReserved: s, name: n, value: t });
      l && o.push(l);
    }
  }
  return o.join("&");
};
var E = (s) => {
  if (!s) return "stream";
  let r = s.split(";")[0]?.trim();
  if (r) {
    if (r.startsWith("application/json") || r.endsWith("+json")) return "json";
    if (r === "multipart/form-data") return "formData";
    if (["application/", "audio/", "image/", "video/"].some((e) => r.startsWith(e))) return "blob";
    if (r.startsWith("text/")) return "text";
  }
};
var $ = async ({ security: s, ...r }) => {
  for (let e of s) {
    let a = await A(e, r.auth);
    if (!a) continue;
    let i = e.name ?? "Authorization";
    switch (e.in) {
      case "query":
        r.query || (r.query = {}), r.query[i] = a;
        break;
      case "cookie":
        r.headers.append("Cookie", `${i}=${a}`);
        break;
      case "header":
      default:
        r.headers.set(i, a);
        break;
    }
    return;
  }
};
var C = (s) => L({ baseUrl: s.baseUrl, path: s.path, query: s.query, querySerializer: typeof s.querySerializer == "function" ? s.querySerializer : k(s.querySerializer), url: s.url });
var L = ({ baseUrl: s, path: r, query: e, querySerializer: a, url: i }) => {
  let o = i.startsWith("/") ? i : `/${i}`, n = (s ?? "") + o;
  r && (n = M({ path: r, url: n }));
  let t = e ? a(e) : "";
  return t.startsWith("?") && (t = t.substring(1)), t && (n += `?${t}`), n;
};
var x = (s, r) => {
  let e = { ...s, ...r };
  return e.baseUrl?.endsWith("/") && (e.baseUrl = e.baseUrl.substring(0, e.baseUrl.length - 1)), e.headers = j(s.headers, r.headers), e;
};
var j = (...s) => {
  let r = new Headers();
  for (let e of s) {
    if (!e || typeof e != "object") continue;
    let a = e instanceof Headers ? e.entries() : Object.entries(e);
    for (let [i, o] of a) if (o === null) r.delete(i);
    else if (Array.isArray(o)) for (let n of o) r.append(i, n);
    else o !== void 0 && r.set(i, typeof o == "object" ? JSON.stringify(o) : o);
  }
  return r;
};
var g = class {
  _fns;
  constructor() {
    this._fns = [];
  }
  clear() {
    this._fns = [];
  }
  getInterceptorIndex(r) {
    return typeof r == "number" ? this._fns[r] ? r : -1 : this._fns.indexOf(r);
  }
  exists(r) {
    let e = this.getInterceptorIndex(r);
    return !!this._fns[e];
  }
  eject(r) {
    let e = this.getInterceptorIndex(r);
    this._fns[e] && (this._fns[e] = null);
  }
  update(r, e) {
    let a = this.getInterceptorIndex(r);
    return this._fns[a] ? (this._fns[a] = e, r) : false;
  }
  use(r) {
    return this._fns = [...this._fns, r], this._fns.length - 1;
  }
};
var v = () => ({ error: new g(), request: new g(), response: new g() });
var V = k({ allowReserved: false, array: { explode: true, style: "form" }, object: { explode: true, style: "deepObject" } });
var F = { "Content-Type": "application/json" };
var w = (s = {}) => ({ ...O, headers: F, parseAs: "auto", querySerializer: V, ...s });
var G = (s = {}) => {
  let r = x(w(), s), e = () => ({ ...r }), a = (n) => (r = x(r, n), e()), i = v(), o = async (n) => {
    let t = { ...r, ...n, fetch: n.fetch ?? r.fetch ?? globalThis.fetch, headers: j(r.headers, n.headers) };
    t.security && await $({ ...t, security: t.security }), t.body && t.bodySerializer && (t.body = t.bodySerializer(t.body)), (t.body === void 0 || t.body === "") && t.headers.delete("Content-Type");
    let l = C(t), u = { redirect: "follow", ...t }, p = new Request(l, u);
    for (let f of i.request._fns) f && (p = await f(p, t));
    let d = t.fetch, c = await d(p);
    for (let f of i.response._fns) f && (c = await f(c, p, t));
    let b = { request: p, response: c };
    if (c.ok) {
      if (c.status === 204 || c.headers.get("Content-Length") === "0") return t.responseStyle === "data" ? {} : { data: {}, ...b };
      let f = (t.parseAs === "auto" ? E(c.headers.get("Content-Type")) : t.parseAs) ?? "json";
      if (f === "stream") return t.responseStyle === "data" ? c.body : { data: c.body, ...b };
      let h = await c[f]();
      return f === "json" && (t.responseValidator && await t.responseValidator(h), t.responseTransformer && (h = await t.responseTransformer(h))), t.responseStyle === "data" ? h : { data: h, ...b };
    }
    let R = await c.text();
    try {
      R = JSON.parse(R);
    } catch {
    }
    let y = R;
    for (let f of i.error._fns) f && (y = await f(R, c, p, t));
    if (y = y || {}, t.throwOnError) throw y;
    return t.responseStyle === "data" ? void 0 : { error: y, ...b };
  };
  return { buildUrl: C, connect: (n) => o({ ...n, method: "CONNECT" }), delete: (n) => o({ ...n, method: "DELETE" }), get: (n) => o({ ...n, method: "GET" }), getConfig: e, head: (n) => o({ ...n, method: "HEAD" }), interceptors: i, options: (n) => o({ ...n, method: "OPTIONS" }), patch: (n) => o({ ...n, method: "PATCH" }), post: (n) => o({ ...n, method: "POST" }), put: (n) => o({ ...n, method: "PUT" }), request: o, setConfig: a, trace: (n) => o({ ...n, method: "TRACE" }) };
};

// src/generated/builder-bridge/client.gen.ts
var client = G(
  w({
    baseUrl: "/api/sdk/builder/v2"
  })
);

// src/generated/builder-bridge/sdk.gen.ts
var getBuilderBridgeOpenApi = (options) => {
  return (options?.client ?? client).get({
    url: "/openapi.yaml",
    ...options
  });
};
var bootstrapBuilderSession = (options) => {
  return (options.client ?? client).get({
    security: [
      {
        name: "x-reclaim-vc-id",
        type: "apiKey"
      }
    ],
    url: "/sessions/{sessionId}/bootstrap",
    ...options
  });
};
var patchBuilderClaimant = (options) => {
  return (options.client ?? client).patch({
    security: [
      {
        name: "x-reclaim-vc-id",
        type: "apiKey"
      }
    ],
    url: "/sessions/{sessionId}/claimant",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
};
var reportBuilderEvent = (options) => {
  return (options.client ?? client).post({
    security: [
      {
        name: "x-reclaim-vc-id",
        type: "apiKey"
      }
    ],
    url: "/sessions/{sessionId}/events",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
};
var createBuilderAttestorAuth = (options) => {
  return (options.client ?? client).post({
    security: [
      {
        name: "x-reclaim-vc-id",
        type: "apiKey"
      }
    ],
    url: "/sessions/{sessionId}/attestor-auth",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
};
var submitBuilderResults = (options) => {
  return (options.client ?? client).post({
    security: [
      {
        name: "x-reclaim-vc-id",
        type: "apiKey"
      }
    ],
    url: "/sessions/{sessionId}/results",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });
};
export {
  ClientVerificationEvent,
  ServerVerificationEvent,
  bootstrapBuilderSession,
  client,
  createBuilderAttestorAuth,
  getBuilderBridgeOpenApi,
  patchBuilderClaimant,
  reportBuilderEvent,
  submitBuilderResults
};
