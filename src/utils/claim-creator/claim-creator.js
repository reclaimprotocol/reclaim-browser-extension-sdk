import {
  extractParamsFromUrl,
  extractParamsFromBody,
  extractParamsFromResponse,
  extractParamsFromBuilderResponse,
  separateParams,
} from "./params-extractor";
import { effectiveResponseMatches } from "./network-filter";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants";
import { ensureOffscreenDocument } from "../offscreen-manager";
import { getUserLocationBasedOnIp } from "./get-dynamic-geo";
import { PRIVATE_KEY_TIMEOUT_MS, DEFAULT_ZK_ENGINE } from "../constants/config";
import { EVENT_TYPES } from "../logger/constants";
import { normalizeRedactionHash } from "../provider-normalization";
import { assertClaimShape } from "./claim-shape";

// Generate Chrome Android user agent (adapted from reference code)
const generateChromeAndroidUserAgent = (chromeMajorVersion = 135, isMobile = true) => {
  if (chromeMajorVersion <= 0) {
    chromeMajorVersion = 135;
  }

  const platform = "(Linux; Android 10; K)";
  const engine = "AppleWebKit/537.36 (KHTML, like Gecko)";
  const chromeVersionString = `Chrome/${chromeMajorVersion}.0.0.0`;
  const mobileToken = isMobile ? " Mobile" : "";
  const safariCompat = "Safari/537.36";

  return `Mozilla/5.0 ${platform} ${engine} ${chromeVersionString}${mobileToken} ${safariCompat}`;
};

const getPrivateKeyFromOffscreen = (sessionId = "unknown", providerId = "unknown", loggingHub) => {
  return new Promise((resolve, reject) => {
    // Timeout after 10 seconds
    const callTimeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(messageListener);
      reject(new Error("Timeout: No response from offscreen document for private key request."));
    }, PRIVATE_KEY_TIMEOUT_MS);

    const messageListener = (message, sender) => {
      // Ensure the message is from the offscreen document and is the expected response
      if (
        message.action === MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE &&
        message.source === MESSAGE_SOURCES.OFFSCREEN &&
        message.target === MESSAGE_SOURCES.BACKGROUND
      ) {
        clearTimeout(callTimeout);
        chrome.runtime.onMessage.removeListener(messageListener);

        if (message.success && message.privateKey) {
          loggingHub.info(
            "[CLAIM-CREATOR] Received private key from offscreen document",
            "claim.privateKey",
          );
          resolve(message.privateKey);
        } else {
          loggingHub.error(
            "[CLAIM-CREATOR] Failed to get private key from offscreen document: " + message.error,
            "claim.privateKey",
          );
          reject(
            new Error(
              message.error || "Unknown error getting private key from offscreen document.",
            ),
          );
        }
        return false; // Indicate message has been handled
      }
      return true; // Keep listener active for other messages
    };

    chrome.runtime.onMessage.addListener(messageListener);

    loggingHub.info(
      "[CLAIM-CREATOR] Requesting private key from offscreen document",
      "claim.privateKey",
    );

    chrome.runtime.sendMessage(
      {
        action: MESSAGE_ACTIONS.GET_PRIVATE_KEY,
        source: MESSAGE_SOURCES.BACKGROUND,
        target: MESSAGE_SOURCES.OFFSCREEN,
        sessionId: sessionId,
        providerId: providerId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          clearTimeout(callTimeout);
          chrome.runtime.onMessage.removeListener(messageListener);
          loggingHub.error(
            "[CLAIM-CREATOR] Error sending GET_PRIVATE_KEY message: " +
              chrome.runtime.lastError.message,
            "claim.privateKey",
          );
          reject(
            new Error(
              `Error sending message to offscreen document: ${chrome.runtime.lastError.message}`,
            ),
          );
        }
      },
    );
  });
};

export const createClaimObject = async (
  request,
  providerData,
  sessionId = "unknown",
  providerId = "unknown",
  loginUrl,
  loggingHub,
  context,
) => {
  loggingHub.info("[CLAIM-CREATOR] Creating claim object from request data", "claim.creation", {
    eventType: EVENT_TYPES.PREPARING_CLAIM,
  });

  // Ensure offscreen document is ready
  try {
    await ensureOffscreenDocument(loggingHub);
    loggingHub.info("[CLAIM-CREATOR] Offscreen document is ready.", "claim.creation", {
      eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_READY,
    });
  } catch (error) {
    loggingHub.error(
      "[CLAIM-CREATOR] Failed to ensure offscreen document: " + error?.message,
      "claim.creation",
    );
    throw new Error(`Failed to initialize offscreen document: ${error.message}`);
  }

  // Generate appropriate user agent for the platform
  // const userAgent = await generateChromeAndroidUserAgent();

  const userAgent =
    (typeof navigator !== "undefined" && navigator.userAgent) || generateChromeAndroidUserAgent();

  // Define public headers that should be in params
  const PUBLIC_HEADERS = [
    "user-agent",
    "accept",
    "accept-language",
    "accept-encoding",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "origin",
    "x-requested-with",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
  ];

  // Initialize params and secretParams objects
  const params = {};
  const secretParams = {};

  // Process URL
  params.url = providerData.urlType === "TEMPLATE" ? providerData.url : request.url;
  params.method = request.method || "GET";

  // Process headers - split between public and secret
  if (request.headers) {
    const publicHeaders = {
      "Sec-Fetch-Mode": "same-origin",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": userAgent,
    };
    const secretHeaders = {
      Referer: (request.referer && String(request.referer)) || loginUrl || origin || "",
    };

    // Cross-origin (and modern same-origin, non-GET/HEAD) fetch/XHR requests always
    // carry a browser-set Origin header, but it's forbidden for page JS to read or
    // set, so the interceptor never captures it — reconstruct it from the page URL.
    const pageOriginSource = request.pageOrigin || loginUrl;
    if (pageOriginSource) {
      try {
        publicHeaders["Origin"] = new URL(pageOriginSource).origin;
      } catch {
        // ignore malformed page URL
      }
    }

    Object.entries(request.headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (PUBLIC_HEADERS.includes(lowerKey)) {
        publicHeaders[key] = value;
      } else {
        secretHeaders[key] = value;
      }
    });

    if (Object.keys(publicHeaders).length > 0) {
      params.headers = publicHeaders;
    }

    if (Object.keys(secretHeaders).length > 0) {
      secretParams.headers = secretHeaders;
    }
  }

  if (request.body) {
    if (providerData?.bodySniff?.enabled) {
      params.body = providerData.bodySniff.template;
    } else {
      params.body = request.body; // pass-through raw body
    }
  }

  if (request.cookieStr) {
    secretParams.cookieStr = request.cookieStr;
  }

  // Extract dynamic parameters from various sources
  let allParamValues = {};

  if (request?.extractedParams && typeof request.extractedParams === "object") {
    allParamValues = { ...allParamValues, ...request.extractedParams };
  }

  // 1. Extract params from URL if provider has URL template
  if (providerData.urlType === "TEMPLATE" && request.url) {
    // append the extracted parameters to the existing allParamValues
    allParamValues = { ...allParamValues, ...extractParamsFromUrl(providerData.url, request.url) };
  }

  // 2. Extract params from request body if provider has body template

  if (providerData?.bodySniff?.enabled && request.body) {
    // append the extracted parameters to the existing allParamValues
    allParamValues = {
      ...allParamValues,
      ...extractParamsFromBody(providerData.bodySniff.template, request.body),
    };
  }

  // 3. Extract params from response if available.
  // allParamValues is passed in as the accumulator so params already derived
  // above (or supplied by a custom injection) count as satisfied — a redaction
  // that can't resolve for an already-known param must not abort the claim.
  // A RedactionResolveError for an *unknown* param propagates on purpose: it
  // means the response doesn't carry the data yet, and the caller treats that
  // as retryable rather than failing the session.
  if (request.responseText && providerData.responseMatches) {
    allParamValues = providerData.builderMode
      ? extractParamsFromBuilderResponse(
          request.responseText,
          providerData.responseMatches,
          providerData.responseRedactions || [],
          allParamValues,
          loggingHub,
        )
      : extractParamsFromResponse(
          request.responseText,
          providerData.responseMatches,
          providerData.responseRedactions || [],
          allParamValues,
          loggingHub,
        );
  }

  // 4. Explicit extractedParams (e.g. from a customInjection request
  // middleware) take precedence over anything auto-derived above — a
  // declared URL/body template regex can't express e.g. a fixed-length
  // split of a path segment, so an injected script's precise value must win.
  if (request?.extractedParams && typeof request.extractedParams === "object") {
    allParamValues = { ...allParamValues, ...request.extractedParams };
  }

  // 5. Separate parameters into public and secret, by NAME only — matching
  // InApp's `_getHttpParams`/`_getSecretParams`, which split on the name
  // containing "SECRET" and nothing else.
  //
  // Hash-bearing params are deliberately NOT forced secret. It reads like a
  // privacy win, but it breaks OPRF outright:
  //
  //  - `secretParams.paramValues` is documented as substituting {{param}} in
  //    the BODY only. A param referenced from `responseMatches` has to be in
  //    `params.paramValues` or the attestor cannot substitute it and the match
  //    fails.
  //  - `updateParametersFromOprfData` (default true in attestor-core
  //    client/create-claim.ts) rewrites `params` — and only `params` —
  //    replacing the raw value with the OPRF nullifier. A value parked in
  //    secretParams is never reached, so no hash is ever substituted.
  //
  // The privacy guarantee for a hashed param comes from that substitution
  // happening client-side before the claim is sent, not from hiding the param.
  const { publicParams, secretParams: secretParamValues } = separateParams(allParamValues);

  // Add parameter values to respective objects
  if (Object.keys(publicParams).length > 0) {
    params.paramValues = publicParams;
  }

  if (Object.keys(secretParamValues).length > 0) {
    secretParams.paramValues = secretParamValues;
  }

  if (providerData.responseMatches) {
    const responseMatches = effectiveResponseMatches(
      request.responseText || "",
      providerData.responseMatches,
      providerData.templateParameters || {},
    );
    params.responseMatches = responseMatches.map((match) => {
      // Create a clean object with only the required fields
      const cleanMatch = {
        value: match.value,
        type: match.type || "contains",
        invert: match.invert || false,
      };

      return cleanMatch;
    });
  }

  // Process response redactions if available.
  //
  // Built as an ALLOWLIST of the four fields the attestor's schema declares.
  // That schema is `additionalProperties: false` and is enforced server-side by
  // AJV (attestor-core server/utils/validation.ts), so one stray key — real
  // provider documents ship `order`, and `description`/`isOptional` appear on
  // sibling structures — fails the whole claim with "Params validation failed",
  // at proof time, after the user has logged in. A denylist cannot be kept in
  // sync with a provider schema that grows independently of this SDK.
  if (providerData.responseRedactions) {
    params.responseRedactions = providerData.responseRedactions.map((redaction) => {
      const cleanedRedaction = {};

      // Empty xPath/jsonPath are omitted rather than sent as "": provider
      // documents use "" for "not set", and the attestor would try to resolve it.
      for (const key of ["xPath", "jsonPath", "regex"]) {
        if (redaction?.[key]) {
          cleanedRedaction[key] = redaction[key];
        }
      }

      // Only `oprf-raw` is supported here; anything else is coerced.
      const hash = normalizeRedactionHash(redaction?.hash, loggingHub);
      if (hash) {
        cleanedRedaction.hash = hash;
      }

      return cleanedRedaction;
    });
  }

  // NOTE: `responseSelections` is deliberately NOT copied into params. It is a
  // legacy provider field with no counterpart in the attestor's
  // HttpProviderParameters schema, and that schema is `additionalProperties:
  // false` — so including it made every claim for such a provider fail
  // validation at the attestor. InApp does not send it either.

  if (providerData.additionalClientOptions) {
    params.additionalClientOptions = providerData.additionalClientOptions;
  }

  if (providerData.writeRedactionMode) {
    params.writeRedactionMode = providerData.writeRedactionMode;
  }

  let ownerPrivateKey;
  try {
    ownerPrivateKey = await getPrivateKeyFromOffscreen(sessionId, providerId, loggingHub);
  } catch (error) {
    loggingHub.error(
      "[CLAIM-CREATOR] Error obtaining owner private key: " + error.message,
      "claim.creation",
    );
    throw new Error(`Could not obtain owner private key: ${error.message}`);
  }

  let geoLocation = providerData?.geoLocation ?? "";

  if (geoLocation === "{{DYNAMIC_GEO}}") {
    geoLocation = await getUserLocationBasedOnIp();
  }

  loggingHub.debug("[CLAIM-CREATOR] Geo location: " + geoLocation, "claim.creation");

  params.geoLocation = geoLocation;

  // Last gate before the attestor. Both schemas are `additionalProperties:
  // false` and AJV-enforced server-side, so an unexpected key means
  // "ERROR_BAD_REQUEST: Params validation failed" at proof time — after the
  // user has logged in, with nothing in the message naming the offending field.
  // Catching it here turns that into an actionable local log.
  assertClaimShape(params, secretParams, loggingHub);

  const claimObject = {
    name: "http",
    sessionId: sessionId,
    params,
    secretParams,
    ownerPrivateKey: ownerPrivateKey,
    zkEngine: providerData?.extensionConfig?.zkEngine || DEFAULT_ZK_ENGINE,
    client: {
      url: "wss://attestor.reclaimprotocol.org:444/ws",
      ...(providerData?.attestorAuthRequest
        ? { authRequest: providerData.attestorAuthRequest }
        : {}),
    },
  };

  loggingHub.info("[CLAIM-CREATOR] Claim object created successfully", "claim.creation");
  // Include user-supplied context (contextAddress & contextMessage) if provided
  if (context && typeof context === "object" && Object.keys(context).length > 0) {
    claimObject.context = context;
  }

  // The full claim. A claim rejected by the attestor ("Params validation
  // failed", a response match that never matches) can only be diagnosed from
  // the exact bytes that were sent, and the redacted form blanks `secretParams`,
  // `paramValues` and `ownerPrivateKey` — the fields most likely to be at fault.
  //
  // At FINE this is the raw object; at the default INFO it is redacted, and
  // `ownerPrivateKey` and the user's live session cookies never leave the
  // device. No per-call opt-out is involved any more: the level decides.
  //
  // Still pass the OBJECT rather than stringifying here — stringifying at the
  // call site would push the raw claim past redaction at every level.
  loggingHub.debug("[CLAIM-CREATOR] Claim object:", "claim.creation", {
    payload: claimObject,
  });

  return claimObject;
};
