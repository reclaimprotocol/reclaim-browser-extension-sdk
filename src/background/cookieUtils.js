import { LOG_LEVEL, LOG_TYPES } from "../utils/logger";

export async function getCookiesForUrl(url, bgLogger) {
  try {
    if (!chrome.cookies || !chrome.cookies.getAll) {
      bgLogger.info({
        message: "[BACKGROUND] Chrome cookies API not available",
        logLevel: LOG_LEVEL.INFO,
        type: LOG_TYPES.BACKGROUND,
        meta: {
          url: url,
        },
      });
      return null;
    }

    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const isHttps = urlObj.protocol === "https:";
    const now = Date.now() / 1000;

    // ---- helpers -----------------------------------------------------------

    // Minimal eTLD+1 guesser (keeps old behavior; avoids dependencies).
    // Not perfect (e.g., co.uk), but we also try full host as a topLevelSite below.
    const guessETLDPlusOne = (host) => {
      const parts = host.split(".");
      if (parts.length <= 2) return host;
      // Heuristic for common 2-level TLDs; extend if you need more.
      const sldTlds = new Set([
        "co.uk",
        "ac.uk",
        "gov.uk",
        "co.in",
        "com.au",
        "com.br",
        "com.mx",
        "com.sg",
      ]);
      const lastTwo = parts.slice(-2).join(".");
      const lastThree = parts.slice(-3).join(".");
      if (sldTlds.has(lastTwo)) return parts.slice(-3).join(".");
      if (sldTlds.has(lastThree)) return parts.slice(-4).join(".");
      return parts.slice(-2).join(".");
    };

    const makeTopLevelSiteCandidates = (host) => {
      // schemeful site strings for partitioned cookies
      const base = guessETLDPlusOne(host);
      const set = new Set();
      set.add(`https://${host}`);
      set.add(`https://${base}`);
      // a common variant (helps when host is bare apex)
      set.add(`https://www.${base}`);
      return [...set];
    };

    const domainVariants = (host) => {
      const parts = host.split(".");
      const variants = new Set();
      variants.add(host);
      for (let i = 1; i < parts.length; i++) {
        variants.add(parts.slice(i).join(".")); // parent without leading dot (API accepts this)
        variants.add("." + parts.slice(i).join(".")); // for safety—some folks pass dotted filter
      }
      return [...variants];
    };

    const getStores = async () => {
      try {
        const stores = await chrome.cookies.getAllCookieStores();
        return Array.isArray(stores) && stores.length ? stores : [{ id: undefined }];
      } catch {
        return [{ id: undefined }];
      }
    };

    const safeGetAll = async (details) => {
      try {
        return await chrome.cookies.getAll(details);
      } catch (error) {
        bgLogger.info({
          message: "[BACKGROUND] cookies.getAll failed for details: ",
          logLevel: LOG_LEVEL.INFO,
          type: LOG_TYPES.BACKGROUND,
          meta: {
            details: details,
            error: error?.message,
          },
        });
        return [];
      }
    };

    // RFC6265-ish domain-match
    const domainMatches = (reqHost, cookieDomain, hostOnly) => {
      if (!cookieDomain) return false;
      if (hostOnly) return reqHost === cookieDomain;
      // Domain cookie: reqHost == cookieDomain OR endsWith("." + cookieDomain)
      // Allow cookieDomain with or without leading dot
      const cd = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
      return reqHost === cd || reqHost.endsWith("." + cd);
    };

    // RFC6265-ish path-match
    const pathMatches = (reqPath, cookiePath) => {
      if (!cookiePath || cookiePath === "/") return true;
      // Must be a prefix
      if (!reqPath.startsWith(cookiePath)) return false;
      // If cookiePath is a prefix and ends with "/", it's fine; if not, next char in reqPath must be "/" (or cookiePath == reqPath)
      if (reqPath.length === cookiePath.length) return true;
      if (cookiePath.endsWith("/")) return true;
      return reqPath.charAt(cookiePath.length) === "/";
    };

    // Use caller's shouldIncludeCookie if present; otherwise do a sane default.
    const defaultShouldIncludeCookie = (cookie) => {
      // Secure cookies only over https
      if (cookie.secure && !isHttps) return false;
      // Expired
      if (cookie.expirationDate && cookie.expirationDate <= now) return false;
      // Domain & path checks
      if (!domainMatches(domain, cookie.domain, cookie.hostOnly)) return false;
      if (!pathMatches(urlObj.pathname || "/", cookie.path)) return false;
      return true; // We intentionally do NOT enforce sameSite here; caller may inject via header/DNR.
    };

    const localShouldInclude =
      typeof shouldIncludeCookie === "function"
        ? (cookie) => shouldIncludeCookie(cookie, urlObj, bgLogger)
        : defaultShouldIncludeCookie;

    // Choose the "better" cookie if we see duplicates (same name+domain+path+partition)
    const betterCookie = (a, b) => {
      // Prefer hostOnly
      if (!!a.hostOnly !== !!b.hostOnly) return a.hostOnly ? a : b;
      // Longer path
      if ((a.path?.length || 0) !== (b.path?.length || 0))
        return (a.path?.length || 0) > (b.path?.length || 0) ? a : b;
      // Later expiration
      const aExp = a.expirationDate || 0;
      const bExp = b.expirationDate || 0;
      if (aExp !== bExp) return aExp > bExp ? a : b;
      // Recent access (if available)
      const aLast = a.lastAccessed || 0;
      const bLast = b.lastAccessed || 0;
      if (aLast !== bLast) return aLast > bLast ? a : b;
      return a; // stable
    };

    // ---- collect cookies ---------------------------------------------------

    const allCookies = [];
    const stores = await getStores();

    // Build a list of queries to fan out (avoid exact duplicates)
    const queries = [];
    const pushQuery = (q) => {
      // stringify to de-dupe
      const key = JSON.stringify(q);
      if (!queries.some((qq) => JSON.stringify(qq) === key)) queries.push(q);
    };

    const dVariants = domainVariants(domain);
    const topLevelSites = makeTopLevelSiteCandidates(domain);

    for (const { id: storeId } of stores) {
      // Domain-based
      for (const d of dVariants) pushQuery({ domain: d, storeId });
      // URL-based
      pushQuery({ url, storeId });

      // Partitioned (CHIPS) queries: for each domain variant + top-level site
      for (const d of dVariants) {
        for (const topLevelSite of topLevelSites) {
          pushQuery({ domain: d, partitionKey: { topLevelSite }, storeId });
        }
      }
      // Also try URL + partitionKey (sometimes catches cookies missed by domain filter)
      for (const topLevelSite of topLevelSites) {
        pushQuery({ url, partitionKey: { topLevelSite }, storeId });
      }
    }

    // Execute queries
    const pages = await Promise.all(queries.map((q) => safeGetAll(q)));
    for (const list of pages) allCookies.push(...list);

    // ---- filter + dedup ----------------------------------------------------

    // Dedup key includes partition topLevelSite (important for CHIPS)
    const keyOf = (c) =>
      [
        c.name,
        c.domain || "",
        c.path || "",
        c.partitionKey?.topLevelSite || "", // distinguish partitioned vs unpartitioned
      ].join("|");

    const candidates = new Map();
    for (const cookie of allCookies) {
      if (!localShouldInclude(cookie)) continue;
      const k = keyOf(cookie);
      const prev = candidates.get(k);
      candidates.set(k, prev ? betterCookie(prev, cookie) : cookie);
    }

    const uniqueCookies = [...candidates.values()];

    if (uniqueCookies.length === 0) return null;

    // Sort: longest path first (server selection favors specificity),
    // then hostOnly, then later expiration.
    uniqueCookies.sort((a, b) => {
      const pl = (p) => (p ? p.length : 0);
      if (pl(a.path) !== pl(b.path)) return pl(b.path) - pl(a.path);
      if (!!a.hostOnly !== !!b.hostOnly) return a.hostOnly ? -1 : 1;
      const aExp = a.expirationDate || 0;
      const bExp = b.expirationDate || 0;
      return bExp - aExp;
    });

    // Build header string
    const cookieStr = uniqueCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return cookieStr || null;
  } catch (error) {
    bgLogger.error({
      message: "[BACKGROUND] Error getting cookies for URL: " + error?.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      meta: {
        error: error?.message,
      },
    });
    return null;
  }
}

export function shouldIncludeCookie(cookie, urlObj, bgLogger) {
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
    bgLogger.info({
      message: "[BACKGROUND] Error checking cookie inclusion: " + error?.message,
      logLevel: LOG_LEVEL.INFO,
      type: LOG_TYPES.BACKGROUND,
      meta: {
        error: error?.message,
      },
    });
    return false;
  }
}
