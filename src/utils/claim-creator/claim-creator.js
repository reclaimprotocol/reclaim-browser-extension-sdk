import {
  extractParamsFromUrl,
  extractParamsFromBody,
  extractParamsFromResponse,
  separateParams,
} from "./params-extractor";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants";
import { ensureOffscreenDocument } from "../offscreen-manager";
import { getUserLocationBasedOnIp } from "./get-dynamic-geo";

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
    }, 10000);

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
  loggingHub.info("[CLAIM-CREATOR] Creating claim object from request data", "claim.creation");

  // Ensure offscreen document is ready
  try {
    await ensureOffscreenDocument(loggingHub);
    loggingHub.info("[CLAIM-CREATOR] Offscreen document is ready.", "claim.creation");
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

  // Process cookie string if available in request
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

  // 3. Extract params from response if available
  if (request.responseText && providerData.responseMatches) {
    // append the extracted parameters to the existing allParamValues
    const extractedParams = extractParamsFromResponse(
      request.responseText,
      providerData.responseMatches,
      providerData.responseRedactions || [],
    );
    allParamValues = {
      ...allParamValues,
      ...extractedParams,
    };
  }

  // 5. Separate parameters into public and secret
  const { publicParams, secretParams: secretParamValues } = separateParams(allParamValues);

  // Add parameter values to respective objects
  if (Object.keys(publicParams).length > 0) {
    params.paramValues = publicParams;
  }

  if (Object.keys(secretParamValues).length > 0) {
    secretParams.paramValues = secretParamValues;
  }

  // Process response matches if available
  if (providerData.responseMatches) {
    params.responseMatches = providerData.responseMatches.map((match) => {
      // Create a clean object with only the required fields
      const cleanMatch = {
        value: match.value,
        type: match.type || "contains",
        invert: match.invert || false,
      };

      return cleanMatch;
    });
  }

  // Process response redactions if available
  if (providerData.responseRedactions) {
    params.responseRedactions = providerData.responseRedactions.map((redaction) => {
      // Create a new object without hash field and empty jsonPath/xPath
      const cleanedRedaction = {};

      Object.entries(redaction).forEach(([key, value]) => {
        // Skip empty jsonPath and xPath
        if ((key === "jsonPath" || key === "xPath") && (!value || value === "")) {
          return;
        }

        // Include hash if it has a value, skip if null/undefined
        if (key === "hash") {
          if (value) {
            cleanedRedaction[key] = value;
          }
          return;
        }

        // Keep all other fields
        cleanedRedaction[key] = value;
      });

      return cleanedRedaction;
    });
  }

  // Process response selections if available
  if (providerData.responseSelections) {
    params.responseSelections = providerData.responseSelections.map((selection) => {
      // Only include value, type, and invert fields
      const cleanedSelection = {};

      if ("value" in selection) {
        cleanedSelection.value = selection.value;
      }

      if ("type" in selection) {
        cleanedSelection.type = selection.type;
      }

      if ("invert" in selection) {
        cleanedSelection.invert = selection.invert;
      }

      return cleanedSelection;
    });
  }

  // Add any additional client options if available
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

  // Create the final claim object
  const claimObject = {
    name: "http",
    sessionId: sessionId,
    params,
    secretParams,
    ownerPrivateKey: ownerPrivateKey,
    zkEngine: "stwo",
    client: {
      url: "ws://localhost:8001/ws",
    },
  };

  loggingHub.info("[CLAIM-CREATOR] Claim object created successfully", "claim.creation");
  // Include user-supplied context (contextAddress & contextMessage) if provided
  if (context && typeof context === "object" && Object.keys(context).length > 0) {
    claimObject.context = context;
  }

  loggingHub.debug(
    "[CLAIM-CREATOR] Claim object: " + JSON.stringify(claimObject, null, 2),
    "claim.creation",
  );

  return claimObject;
};
