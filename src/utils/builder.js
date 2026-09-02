import {
  VerificationEvent as BUILDER_EVENTS,
  bootstrapVerificationClient as bootstrapBuilderSession,
  client as generatedBuilderBridgeClient,
  createVerificationAttestorAuth as createBuilderAttestorAuth,
  patchVerificationClaimant as patchBuilderClaimant,
  reportVerificationEvent as reportBuilderEvent,
  submitVerificationClientResult as submitBuilderResults,
} from "../generated/builder-bridge.gen.js";

export { BUILDER_EVENTS };

// Builder owns the api=2 verification API. Keep legacy provider/session traffic on the
// existing API origin, but default Builder verification to the Builder origin.
export const BUILDER_BACKEND_URL = "https://build.reclaimprotocol.org";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate and canonicalize a Builder Verification Client UUID. Builder
 * compares this identifier in both request headers and session-bound payloads;
 * keeping one representation avoids a casing mismatch between the two.
 */
export function normalizeVerificationClientId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error("verificationClientId must be a registered Verification Client UUID");
  }
  return value.trim().toLowerCase();
}

/**
 * Merge parameters discovered while observing a request with Builder's
 * explicit values. Session parameters intentionally outrank URL/body/response
 * captures; a provider script's requestClaim values are the most specific and
 * therefore have final precedence.
 */
export function mergeBuilderParameterSources({
  url = {},
  body = {},
  response = {},
  template = {},
  extracted = {},
} = {}) {
  return {
    ...url,
    ...body,
    ...response,
    ...template,
    ...extracted,
  };
}

/**
 * Return the Builder contract's required extracted parameter map from a raw
 * attestor proof. The attestor has emitted claim.context as either JSON text
 * or an object in different client versions, so accept both representations
 * and always provide the required object field to Builder.
 */
export function builderExtractedParameterValues(proof) {
  if (proof && typeof proof === "object" && !Array.isArray(proof)) {
    const explicit = proof.extractedParameterValues;
    if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) return explicit;

    const context = proof.claim?.context;
    if (context && typeof context === "object" && !Array.isArray(context)) {
      const extracted = context.extractedParameters;
      if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) return extracted;
    }

    if (typeof context === "string") {
      try {
        const parsed = JSON.parse(context);
        const extracted = parsed?.extractedParameters;
        if (extracted && typeof extracted === "object" && !Array.isArray(extracted))
          return extracted;
      } catch {
        // Older attestors can return a non-JSON context; the contract still
        // requires a map, so fall back to the empty map below.
      }
    }
  }
  return {};
}

export function interpolateBuilderTemplate(value, parameters = {}) {
  if (typeof value !== "string" || !value.includes("{{")) return value;
  return value.replace(/\{\{([^{}]+)\}\}/g, (placeholder, parameter) =>
    Object.prototype.hasOwnProperty.call(parameters, parameter)
      ? String(parameters[parameter])
      : placeholder,
  );
}

/**
 * Resolve values in a Builder request-header map. Header values are not passed
 * through the attestor's normal URL/body substitution path, so static recipe
 * headers need to be materialized before the claim is sent.
 */
export function interpolateBuilderHeaders(headers, parameters = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      interpolateBuilderTemplate(value, parameters),
    ]),
  );
}

/**
 * Adds only the Builder context parameters selected by the recipe. Explicit
 * parameters keep precedence. Context aliases resolve in this order:
 * context.foo, context_foo, then foo.
 */
export function builderTemplateParameters(explicitParameters, context, recipe) {
  const parameters =
    explicitParameters &&
    typeof explicitParameters === "object" &&
    !Array.isArray(explicitParameters)
      ? { ...explicitParameters }
      : {};
  if (!context || typeof context !== "object" || Array.isArray(context)) return parameters;
  const requestedNames = builderRecipeParameterNames(recipe);
  for (const [key, value] of Object.entries(context)) {
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    const stringValue = String(value);
    const contextKey = `context.${key}`;
    const underscoreKey = `context_${key}`;
    const selectedName = selectBuilderContextParameterName(
      key,
      contextKey,
      underscoreKey,
      requestedNames,
    );
    if (selectedName && !Object.prototype.hasOwnProperty.call(parameters, selectedName)) {
      parameters[selectedName] = stringValue;
    }
  }
  return parameters;
}

/**
 * Resolve one provider's parameters while retaining the values supplied at
 * session start when the next provider transition has no new request object.
 */
export function builderProviderParameters(
  templateParameters,
  persistedParameters,
  context,
  recipe,
) {
  return builderTemplateParameters(templateParameters ?? persistedParameters, context, recipe);
}

function selectBuilderContextParameterName(key, contextKey, underscoreKey, requestedNames) {
  if (requestedNames.has(contextKey)) return contextKey;
  if (key === "reclaimSessionId" || key === "attestationNonce") return null;
  if (requestedNames.has(underscoreKey)) return underscoreKey;
  if (requestedNames.has(key)) return key;
  return null;
}

function builderRecipeParameterNames(recipe) {
  const names = new Set();
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return names;

  const collectTemplateNames = (value) => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) names.add(match[1]);
  };
  collectTemplateNames(recipe.initialUrl);
  collectTemplateNames(recipe.geoLocation);
  for (const request of Array.isArray(recipe.requests) ? recipe.requests : []) {
    if (!request || typeof request !== "object" || Array.isArray(request)) continue;
    collectTemplateNames(request.url);
    collectTemplateNames(request.requestBodyTemplate);
    if (request.headers && typeof request.headers === "object" && !Array.isArray(request.headers)) {
      for (const value of Object.values(request.headers)) collectTemplateNames(value);
    }
    for (const match of Array.isArray(request.responseMatches) ? request.responseMatches : []) {
      collectTemplateNames(match?.value);
    }
    for (const redaction of Array.isArray(request.responseRedactions)
      ? request.responseRedactions
      : []) {
      if (!redaction || typeof redaction !== "object" || Array.isArray(redaction)) continue;
      for (const value of Object.values(redaction)) {
        collectTemplateNames(value);
        if (typeof value !== "string") continue;
        for (const match of value.matchAll(/\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/g)) {
          names.add(match[1]);
        }
      }
    }
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

export function createBuilderBridgeClient({
  backendUrl = BUILDER_BACKEND_URL,
  verificationClientId,
}) {
  const baseUrl = normalizeBackendUrl(backendUrl);
  const vcId = normalizeVerificationClientId(verificationClientId);

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
    if (!generatedBaseUrl) throw new Error("Generated Builder client has no server URL");
    let generatedPath = "";
    try {
      generatedPath = new URL(generatedBaseUrl).pathname;
    } catch {
      generatedPath = generatedBaseUrl;
    }
    return {
      baseUrl: new URL(generatedPath || "/", `${baseUrl}/`).toString().replace(/\/+$/, ""),
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
        builderMode: true,
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
  if (url.hostname.toLowerCase() === "api.reclaimprotocol.org") {
    throw new Error("Builder backendUrl cannot use the legacy Reclaim API");
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
    // Builder returns the legacy base64 body directly.
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
