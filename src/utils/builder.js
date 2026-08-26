import { BACKEND_URL } from "./constants/constants.js";

const BUILDER_BRIDGE_PATH = "/api/sdk/builder/v2/sessions";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BUILDER_EVENTS = {
  CLIENT_OPENED: "verification_client_opened",
  CLIENT_READY: "verification_client_ready",
  BROWSER_STARTED: "verification_browser_started",
  BROWSER_READY: "verification_browser_ready",
  PAGE_READY: "verification_page_ready",
  INTERCEPTOR_READY: "verification_request_interceptor_ready",
  PROVIDER_STARTED: "verification_provider_started",
  PROVIDER_COMPLETED: "verification_provider_completed",
  REQUEST_MATCHED: "request_matched",
  CLAIM_CREATED: "request_claim_created",
  CLAIM_COMPLETED: "request_claim_completed",
  CLAIM_FAILED: "request_claim_failed",
  PROOFS_COMPLETED: "verification_proofs_completed",
  RESULT_SUBMITTING: "verification_result_submitting",
  RESULT_SUBMISSION_FAILED: "verification_result_submission_failed",
  CANCELLED: "verification_cancelled",
};

/**
 * Adds missing Builder template parameters from the session context.
 * Explicit parameters keep precedence, and context.foo remains available for
 * templates that use the explicit context namespace.
 */
export function builderTemplateParameters(explicitParameters, context, recipe) {
  const parameters =
    explicitParameters &&
    typeof explicitParameters === "object" &&
    !Array.isArray(explicitParameters)
      ? { ...explicitParameters }
      : {};
  if (!context || typeof context !== "object" || Array.isArray(context)) return parameters;
  const names = builderRecipePlaceholderNames(recipe);

  for (const [key, value] of Object.entries(context)) {
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    const stringValue = String(value);
    const contextKey = `context.${key}`;
    if (
      key !== "reclaimSessionId" &&
      key !== "attestationNonce" &&
      names.has(key) &&
      !names.has(contextKey) &&
      !Object.prototype.hasOwnProperty.call(parameters, key)
    ) {
      parameters[key] = stringValue;
    }
    if (!Object.prototype.hasOwnProperty.call(parameters, contextKey)) {
      parameters[contextKey] = stringValue;
    }
  }
  return parameters;
}

function builderRecipePlaceholderNames(recipe) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return new Set();
  const templates = [recipe.geoLocation];
  for (const request of Array.isArray(recipe.requests) ? recipe.requests : []) {
    templates.push(request?.url, request?.requestBodyTemplate);
    for (const match of Array.isArray(request?.responseMatches) ? request.responseMatches : []) {
      templates.push(match?.value);
    }
  }

  const names = new Set();
  for (const template of templates) {
    if (typeof template !== "string") continue;
    for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) names.add(match[1]);
  }
  return names;
}

/**
 * Parses an incoming verification URL without interpreting legacy fields.
 * Only the exact `api=2` form opts into Builder; every other URL remains
 * legacy so existing integrations retain their current behaviour.
 */
export function parseVerificationUrl(value) {
  const baseUrl = typeof location === "undefined" ? "https://reclaim.local" : location.href;
  const url = value instanceof URL ? value : new URL(value, baseUrl);
  if (url.searchParams.get("api") !== "2") {
    return { mode: "legacy", url };
  }

  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    throw new Error("Builder verification URLs require a non-empty sessionId");
  }

  return { mode: "builder", sessionId, url };
}

export function createBuilderBridgeClient({ backendUrl = BACKEND_URL, verificationClientId }) {
  if (typeof verificationClientId !== "string" || !UUID_PATTERN.test(verificationClientId.trim())) {
    throw new Error("verificationClientId must be a registered Verification Client UUID");
  }

  const baseUrl = normalizeBackendUrl(backendUrl);
  const vcId = verificationClientId.trim().toLowerCase();

  return {
    async bootstrap(sessionId) {
      return request(sessionId, "/bootstrap");
    },

    async getAttestorAuth(sessionId) {
      const response = await fetch(sessionUrl(sessionId, "/attestor-auth"), {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Builder attestor authorization failed (${response.status})`);
      }
      if (!body) return null;

      const encoded = decodeAuthorizationEnvelope(body);
      const decoded = JSON.parse(decodeBase64(encoded));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("Builder attestor authorization must decode to an object");
      }
      if (typeof decoded.signature === "string") {
        decoded.signature = decodeBase64Bytes(decoded.signature);
      }
      return decoded;
    },

    async reportEvent(sessionId, event, eventData) {
      return request(sessionId, "/events", {
        method: "POST",
        body: JSON.stringify({
          event,
          ...(eventData ? { eventData } : {}),
          occurredAt: new Date().toISOString(),
        }),
      });
    },

    async reportEventBestEffort(sessionId, event, eventData) {
      try {
        await this.reportEvent(sessionId, event, eventData);
        return true;
      } catch {
        return false;
      }
    },

    async patchClaimant(sessionId, details) {
      return request(sessionId, "/claimant", {
        method: "PATCH",
        body: JSON.stringify(details),
      });
    },

    async submitResult(sessionId, result) {
      return request(sessionId, "/results", {
        method: "POST",
        body: JSON.stringify(result),
      });
    },
  };

  function sessionUrl(sessionId, suffix) {
    const normalized = String(sessionId || "").trim();
    if (!normalized) throw new Error("Builder sessionId must be a non-empty string");
    return `${baseUrl}${BUILDER_BRIDGE_PATH}/${encodeURIComponent(normalized)}${suffix}`;
  }

  function headers() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-reclaim-vc-id": vcId,
    };
  }

  async function request(sessionId, suffix, init = {}) {
    const response = await fetch(sessionUrl(sessionId, suffix), {
      ...init,
      headers: headers(),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Builder bridge request failed (${response.status})`);
    }
    return body;
  }
}

/** Converts a resolved Builder recipe into the extension's existing provider shape. */
export function builderRecipeToProviderData(recipe, providerOrdinal) {
  if (!recipe || typeof recipe !== "object") {
    throw new Error("Builder recipe must be an object");
  }
  const providerId = requiredString(recipe.providerId, "providerId");
  const resolvedVersion = requiredString(recipe.resolvedVersion, "resolvedVersion");
  const initialUrl = requiredString(recipe.initialUrl, "initialUrl");
  if (!Array.isArray(recipe.requests) || recipe.requests.length === 0) {
    throw new Error(`Builder recipe ${providerId} must include at least one request`);
  }

  return {
    builderMode: true,
    name: providerId,
    loginUrl: initialUrl,
    resolvedVersion,
    geoLocation: typeof recipe.geoLocation === "string" ? recipe.geoLocation : "",
    customInjection: typeof recipe.jsUserScripts === "string" ? recipe.jsUserScripts : "",
    injectionType: recipe.injectionType || "HAWKEYE",
    extensionConfig:
      recipe.clientOptions?.extension && typeof recipe.clientOptions.extension === "object"
        ? recipe.clientOptions.extension
        : {},
    requestData: recipe.requests.map((request, requestOrdinal) => {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new Error(`Builder recipe ${providerId} request ${requestOrdinal} is invalid`);
      }
      const url = requiredString(request.url, `requests[${requestOrdinal}].url`);
      const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
      const requestBodyTemplate = request.requestBodyTemplate;
      if (requestBodyTemplate != null && typeof requestBodyTemplate !== "string") {
        throw new Error(
          `Builder recipe ${providerId} request ${requestOrdinal} has an invalid requestBodyTemplate`,
        );
      }

      return {
        url,
        expectedPageUrl: initialUrl,
        urlType: url.includes("{{") ? "TEMPLATE" : "CONSTANT",
        method,
        responseMatches: Array.isArray(request.responseMatches) ? request.responseMatches : [],
        responseRedactions: Array.isArray(request.responseRedactions)
          ? request.responseRedactions
          : [],
        ...(requestBodyTemplate
          ? { bodySniff: { enabled: true, template: requestBodyTemplate } }
          : {}),
        ...(request.credentials ? { credentials: request.credentials } : {}),
        ...(request.writeRedactionMode ? { writeRedactionMode: request.writeRedactionMode } : {}),
        ...(request.additionalClientOptions
          ? { additionalClientOptions: request.additionalClientOptions }
          : {}),
        ...(typeof request.requestId === "string" && request.requestId
          ? { builderRequestId: request.requestId }
          : {}),
        requestHash: `builder:${providerOrdinal}:${requestOrdinal}`,
      };
    }),
  };
}

export function builderProblem(reasonCode, title, retryable) {
  return {
    type: `https://build.reclaimprotocol.org/problems/${reasonCode.toLowerCase().replaceAll("_", "-")}`,
    title,
    reasonCode,
    retryable,
  };
}

function normalizeBackendUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Builder backendUrl must use HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Builder recipe ${name} must be a non-empty string`);
  }
  return value;
}

function decodeAuthorizationEnvelope(body) {
  try {
    const decoded = JSON.parse(body);
    if (typeof decoded === "string") return decoded;
    if (decoded && typeof decoded.authorization === "string") return decoded.authorization;
  } catch {
    // The bridge returns the legacy base64 body directly.
  }
  return body;
}

function decodeBase64(value) {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

function decodeBase64Bytes(value) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
