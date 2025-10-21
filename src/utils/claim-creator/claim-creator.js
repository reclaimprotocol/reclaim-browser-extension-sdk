import {
  extractParamsFromUrl,
  extractParamsFromBody,
  extractParamsFromResponse,
  separateParams,
} from "./params-extractor";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES } from "../constants";
import { ensureOffscreenDocument } from "../offscreen-manager";
import { getUserLocationBasedOnIp } from "./get-dynamic-geo";
import { EVENT_TYPES, LOG_LEVEL, LOG_TYPES } from "../logger/constants";

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

const getPrivateKeyFromOffscreen = (sessionId = "unknown", providerId = "unknown", bgLogger) => {
  bgLogger.setContext({
    sessionId: sessionId,
    providerId: providerId,
    type: LOG_TYPES.CLAIM_CREATION,
  });
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
        // Assuming this script runs in background context

        clearTimeout(callTimeout);
        chrome.runtime.onMessage.removeListener(messageListener);

        if (message.success && message.privateKey) {
          bgLogger.info({
            message: "[CLAIM-CREATOR] Received private key from offscreen document",
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.CLAIM_CREATION,
          });
          resolve(message.privateKey);
        } else {
          bgLogger.error({
            message:
              "[CLAIM-CREATOR] Failed to get private key from offscreen document: " + message.error,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.CLAIM_CREATION,
          });
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

    bgLogger.info({
      message: "[CLAIM-CREATOR] Requesting private key from offscreen document",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.CLAIM_CREATION,
    });

    chrome.runtime.sendMessage(
      {
        action: MESSAGE_ACTIONS.GET_PRIVATE_KEY,
        source: MESSAGE_SOURCES.BACKGROUND, // Assuming this script runs in background context
        target: MESSAGE_SOURCES.OFFSCREEN,
        sessionId: sessionId,
        providerId: providerId,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          clearTimeout(callTimeout);
          chrome.runtime.onMessage.removeListener(messageListener);
          bgLogger.error({
            message:
              "[CLAIM-CREATOR] Error sending GET_PRIVATE_KEY message: " +
              chrome.runtime.lastError.message,
            logLevel: LOG_LEVEL.INFO,
            type: LOG_TYPES.CLAIM_CREATION,
          });
          reject(
            new Error(
              `Error sending message to offscreen document: ${chrome.runtime.lastError.message}`,
            ),
          );
        }
        // If offscreen.js calls sendResponse synchronously, it can be handled here
        // but the main logic relies on the async messageListener
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
  bgLogger,
) => {
  bgLogger.setContext({
    sessionId: sessionId,
    providerId: providerId,
    type: LOG_TYPES.CLAIM_CREATION,
  });

  bgLogger.info({
    message: "[CLAIM-CREATOR] Creating claim object from request data",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.CLAIM_CREATION,
    eventType: EVENT_TYPES.CLAIM_CREATION_STARTED,
  });
  // Ensure offscreen document is ready
  try {
    await ensureOffscreenDocument(bgLogger);
    bgLogger.info({
      message: "[CLAIM-CREATOR] Offscreen document is ready.",
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.CLAIM_CREATION,
      eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_READY,
    });
  } catch (error) {
    bgLogger.error({
      message: "[CLAIM-CREATOR] Failed to ensure offscreen document: " + error?.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.CLAIM_CREATION,
      eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_NOT_READY_EXCEPTION,
      meta: {
        error: error?.message,
        request: request,
        providerData: providerData,
        sessionId: sessionId,
        loginUrl: loginUrl,
      },
    });
    // Depending on requirements, you might want to throw error or handle differently
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
    allParamValues = {
      ...allParamValues,
      ...extractParamsFromResponse(
        request.responseText,
        providerData.responseMatches,
        providerData.responseRedactions || [],
      ),
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
        // Skip the hash field
        if (key === "hash") {
          return;
        }

        // Skip empty jsonPath and xPath
        if ((key === "jsonPath" || key === "xPath") && (!value || value === "")) {
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

  let ownerPrivateKey;
  try {
    ownerPrivateKey = await getPrivateKeyFromOffscreen(sessionId, providerId, bgLogger);
  } catch (error) {
    // Fallback or re-throw, depending on how critical the key is.
    // For now, let's re-throw to make the failure visible.
    bgLogger.error({
      message: "[CLAIM-CREATOR] Error obtaining owner private key: " + error.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.CLAIM_CREATION,
      eventType: EVENT_TYPES.CLAIM_CREATION_FAILED,
    });
    throw new Error(`Could not obtain owner private key: ${error.message}`);
  }

  let geoLocation = providerData?.geoLocation ?? "";

  if (geoLocation === "{{DYNAMIC_GEO}}") {
    geoLocation = await getUserLocationBasedOnIp();
  }

  bgLogger.log({
    message: "[CLAIM-CREATOR] Geo location: " + geoLocation,
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.CLAIM_CREATION,
  });

  params.geoLocation = geoLocation;

  // Create the final claim object
  const claimObject = {
    name: "http",
    sessionId: sessionId,
    params,
    secretParams,
    ownerPrivateKey: ownerPrivateKey,
    client: {
      url: "wss://attestor.reclaimprotocol.org/ws",
    },
  };

  bgLogger.info({
    message: "[CLAIM-CREATOR] Claim object created successfully",
    logLevel: LOG_LEVEL.INFO,
    type: LOG_TYPES.CLAIM_CREATION,
    eventType: EVENT_TYPES.CLAIM_CREATION_SUCCESS,
  });

  bgLogger.log({
    message: "[CLAIM-CREATOR] Claim object: " + JSON.stringify(claimObject, null, 2),
    logLevel: LOG_LEVEL.ALL,
    type: LOG_TYPES.CLAIM_CREATION,
  });

  return claimObject;
};
