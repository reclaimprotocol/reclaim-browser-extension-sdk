import { BACKEND_URL } from "./constants/constants.js";
import {
  ClientVerificationEvent as BUILDER_EVENTS,
  bootstrapBuilderSession,
  client as generatedBuilderBridgeClient,
  createBuilderAttestorAuth,
  patchBuilderClaimant,
  reportBuilderEvent,
  submitBuilderResults,
} from "../generated/builder-bridge.gen.js";

export { BUILDER_EVENTS };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  return { mode: "builder", sessionId, diagnosticMode: url.searchParams.get("diag") === "1", url };
}

export function createBuilderBridgeClient({ backendUrl = BACKEND_URL, verificationClientId }) {
  if (typeof verificationClientId !== "string" || !UUID_PATTERN.test(verificationClientId.trim())) {
    throw new Error("verificationClientId must be a registered Verification Client UUID");
  }

  const baseUrl = normalizeBackendUrl(backendUrl);
  const vcId = verificationClientId.trim().toLowerCase();

  return {
    async bootstrap(sessionId) {
      const { data } = await bootstrapBuilderSession(requestOptions(sessionId));
      return data;
    },

    async getAttestorAuth(sessionId) {
      const response = await createBuilderAttestorAuth({
        ...requestOptions(sessionId),
        body: {},
      });
      if (
        response.response.status === 204 ||
        response.response.headers.get("Content-Length") === "0"
      ) {
        return null;
      }
      const body = response.data;
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
      const { data } = await reportBuilderEvent({
        ...requestOptions(sessionId),
        body: {
          event,
          ...(eventData ? { eventData } : {}),
          occurredAt: new Date().toISOString(),
        },
      });
      return data;
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
      const { data } = await patchBuilderClaimant({
        ...requestOptions(sessionId),
        body: details,
      });
      return data;
    },

    async submitResult(sessionId, result) {
      const { data } = await submitBuilderResults({
        ...requestOptions(sessionId),
        body: result,
      });
      return data;
    },
  };

  function requestOptions(sessionId) {
    const normalized = String(sessionId || "").trim();
    if (!normalized) throw new Error("Builder sessionId must be a non-empty string");
    const generatedBaseUrl = generatedBuilderBridgeClient.getConfig().baseUrl;
    if (!generatedBaseUrl) throw new Error("Generated Builder bridge client has no server URL");
    return {
      baseUrl: new URL(generatedBaseUrl, `${baseUrl}/`).toString().replace(/\/+$/, ""),
      path: { sessionId: normalized },
      headers: { "x-reclaim-vc-id": vcId },
      throwOnError: true,
    };
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
        ...(request.headers && typeof request.headers === "object"
          ? { headers: request.headers }
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
