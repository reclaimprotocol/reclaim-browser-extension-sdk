// Cookie utilities for background script
// Handles cookie fetching and filtering logic

export async function getCookiesForUrl(url, debugLogger, DebugLogType) {
  try {
    if (!chrome.cookies || !chrome.cookies.getAll) {
      debugLogger.warn(DebugLogType.BACKGROUND, "[BACKGROUND] Chrome cookies API not available");
      return null;
    }

    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    const allCookies = [];

    const exactDomainCookies = await chrome.cookies.getAll({ domain });
    allCookies.push(...exactDomainCookies);

    const domainParts = domain.split(".");
    for (let i = 1; i < domainParts.length; i++) {
      const parentDomain = "." + domainParts.slice(i).join(".");
      try {
        const parentCookies = await chrome.cookies.getAll({ domain: parentDomain });
        allCookies.push(...parentCookies);
      } catch (error) {
        debugLogger.warn(
          DebugLogType.BACKGROUND,
          `[BACKGROUND] Could not get cookies for parent domain ${parentDomain}:`,
          error,
        );
      }
    }

    try {
      const urlCookies = await chrome.cookies.getAll({ url });
      allCookies.push(...urlCookies);
    } catch (error) {
      debugLogger.warn(
        DebugLogType.BACKGROUND,
        `[BACKGROUND] Could not get cookies by URL ${url}:`,
        error,
      );
    }

    const uniqueCookies = [];
    const cookieKeys = new Set();

    for (const cookie of allCookies) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      if (!cookieKeys.has(key)) {
        const shouldInclude = shouldIncludeCookie(cookie, urlObj, debugLogger, DebugLogType);
        if (shouldInclude) {
          cookieKeys.add(key);
          uniqueCookies.push(cookie);
        }
      }
    }

    if (uniqueCookies.length > 0) {
      uniqueCookies.sort((a, b) => {
        if (a.path.length !== b.path.length) {
          return b.path.length - a.path.length;
        }
        return (a.creationDate || 0) - (b.creationDate || 0);
      });

      const cookieStr = uniqueCookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return cookieStr;
    }

    return null;
  } catch (error) {
    debugLogger.error(
      DebugLogType.BACKGROUND,
      "[BACKGROUND] Error getting cookies for URL:",
      error,
    );
    return null;
  }
}

export function shouldIncludeCookie(cookie, urlObj, debugLogger, DebugLogType) {
  try {
    // Check domain match
    const cookieDomain = cookie.domain.startsWith(".") ? cookie.domain.substring(1) : cookie.domain;
    const requestDomain = urlObj.hostname;

    const domainMatches =
      requestDomain === cookieDomain ||
      requestDomain.endsWith("." + cookieDomain) ||
      (cookie.domain.startsWith(".") && requestDomain.endsWith(cookie.domain.substring(1)));

    if (!domainMatches) {
      return false;
    }

    // Check path match
    const cookiePath = cookie.path || "/";
    const requestPath = urlObj.pathname;
    const pathMatches = requestPath.startsWith(cookiePath);

    if (!pathMatches) {
      return false;
    }

    // Check secure flag
    const isSecureRequest = urlObj.protocol === "https:";
    if (cookie.secure && !isSecureRequest) {
      return false;
    }

    // Check if cookie is expired
    if (cookie.expirationDate && cookie.expirationDate < Date.now() / 1000) {
      return false;
    }

    return true;
  } catch (error) {
    debugLogger.warn(
      DebugLogType.BACKGROUND,
      "[BACKGROUND] Error checking cookie inclusion:",
      error,
    );
    return false;
  }
}
