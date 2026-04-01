(function () {
  // Anti-detection: Randomize function names and add delays
  const randomDelay = () =>
    new Promise((resolve) => setTimeout(resolve, Math.random() * 2000 + 1000));

  // Global state to prevent double execution
  const STATE_KEY = `_reclaim_${Math.random().toString(36).substr(2, 9)}`;
  window[STATE_KEY] = {
    processing: false,
    completed: false,
    lastUrl: null,
  };

  async function processData() {
    try {
      console.log("[RECLAIM] processData called, url:", window.location.href);
      if (!window.location.href.includes("https://chatgpt.com")) {
        console.log("[RECLAIM] EXIT: not chatgpt url");
        return;
      }

      const currentUrl = window.location.href;
      const state = window[STATE_KEY];

      // Prevent concurrent execution
      if (state.processing) {
        console.log("[RECLAIM] EXIT: already processing");
        return;
      }

      // Prevent re-execution on same URL if already completed
      if (state.completed && state.lastUrl === currentUrl) {
        console.log("[RECLAIM] EXIT: already completed for this url");
        return;
      }

      // Mark as processing
      state.processing = true;
      state.lastUrl = currentUrl;
      console.log("[RECLAIM] started processing");

      // Add random delay before execution
      await randomDelay();

      // Check login state without obvious selectors
      const buttonElements = document.querySelectorAll("button, a");
      const loginButtons = Array.from(buttonElements).filter(
        (el) =>
          el.textContent?.toLowerCase().includes("log in") ||
          el.getAttribute("data-testid")?.includes("login"),
      );

      console.log("[RECLAIM] login buttons found:", loginButtons.length);

      if (loginButtons && loginButtons.length > 0) {
        if (state.loginClicked) {
          console.log("[RECLAIM] EXIT: login already clicked");
          return;
        }
        state.loginClicked = true;
        console.log("[RECLAIM] clicking login button");
        await randomDelay();
        // @ts-ignore
        // loginButtons[0].click();
        state.processing = false;
        return;
      }

      // Try to get data from existing DOM first
      let userId, planType;
      const scripts = document.querySelectorAll("script");

      for (let script of scripts) {
        const content = script.textContent || script.innerText || "";
        if (content.length > 100) {
          const emailMatch = content.match(/"email":"(.*?)"/);
          const planMatch = content.match(/"planType":"(.*?)"/);

          if (emailMatch) userId = emailMatch[1];
          if (planMatch) planType = planMatch[1];

          if (userId && planType) break;
        }
      }

      console.info({ userId, planType, tag: "lookup results from DOM" });

      // If not found in DOM, make a stealthy request
      if (!userId || !planType) {
        console.log("[RECLAIM] not found in DOM, fetching page");
        await randomDelay();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(window.location.href, {
          headers: {
            accept: "*/*",
            "accept-language": navigator.language || "en-US,en;q=0.9",
            "cache-control": "no-cache",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
          },
          method: "GET",
          credentials: "include",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          console.error("Unsuccessful chatgpt userId/planType check", {
            status: response.status,
            statusText: response.statusText,
          });
          console.log("Unsuccessful chatgpt userId/planType response:", {
            response: await response.text(),
          });
          console.log("[RECLAIM] EXIT: fetch response not ok", response.status);
          state.processing = false;
          return;
        }

        console.log("[RECLAIM] fetch response ok, parsing html");
        const html = await response.text();

        const userMatch = html.match(/"email":"(.*?)"/);
        const typeMatch = html.match(/"planType":"(.*?)"/);

        userId = userMatch?.[1];
        planType = typeMatch?.[1];

        console.info({
          userMatch,
          typeMatch,
          userId,
          planType,
          tag: "in html response lookup",
        });
      }

      console.info({
        userId,
        planType,
        tag: "after html dom and html response lookup",
      });

      if (!userId || !planType) {
        console.log("[RECLAIM] EXIT: userId or planType not found after all lookups");
        state.processing = false;
        return;
      }

      // Only log in development
      if (window.location.hostname === "localhost" || window.console?.clear) {
        console.log(`User: ${userId.substring(0, 3)}...`);
        console.log(`Plan: ${planType}`);
      }

      console.info("waiting for random delay");

      await randomDelay();

      console.info("done with random delay");

      const claimData = {
        geoLocation: "{{DYNAMIC_GEO}}",
        url: window.location.origin + "/",
        cookies: document.cookie || "",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": navigator.language || "en-US,en;q=0.9",
          "user-agent": navigator.userAgent,
          "sec-fetch-mode": "navigate",
        },
        method: "GET",
        responseBody: "response",
        extractedParams: {
          userId: userId,
          planType: planType,
        },
        responseMatches: [
          {
            type: "contains",
            value: "{{userId}}",
          },
          {
            type: "regex",
            value: '"planType":"(?<planType>.*?)"',
          },
        ],
        responseRedactions: [{ regex: "{{userId}}" }, { regex: '"planType":"(?<planType>.*?)"' }],
      };

      console.info({
        userId,
        planType,
        claimData,
        tag: "sending claim",
      });

      // Check if Reclaim is available and call only once
      if (
        typeof window.Reclaim === "object" &&
        window.Reclaim &&
        typeof window.Reclaim.requestClaim === "function"
      ) {
        console.info("Claim sent");
        await window.Reclaim.requestClaim(claimData);

        // Mark as completed after successful claim
        state.completed = true;
      }

      // Reset processing flag
      state.processing = false;
    } catch (error) {
      console.error("[RECLAIM] EXCEPTION in processData:", error);

      // Reset processing flag on error
      window[STATE_KEY].processing = false;

      // Silent fail - don't log errors that might be detected
      if (window.location.hostname === "localhost") {
        console.error("Process error:", error.message);
      }
    }
  }

  let _interruptingButtonsInterval = null;
  const keepClickingInterruptingButtons = () => {
    if (_interruptingButtonsInterval) return;
    _interruptingButtonsInterval = setInterval(() => {
      const buttonElements = document.querySelectorAll("button, a");
      const maybeLaterButton = Array.from(buttonElements).filter((el) =>
        el.textContent?.toLowerCase().includes("maybe later"),
      );
      const rejectNonEssentialButton = Array.from(buttonElements).filter((el) =>
        el.textContent?.toLowerCase().includes("reject non-essential"),
      );
      if (maybeLaterButton && maybeLaterButton.length > 0) {
        let e = maybeLaterButton[0];
        if ("click" in e && typeof e.click == "function") {
          e.click();
        }
      }
      if (rejectNonEssentialButton && rejectNonEssentialButton.length > 0) {
        let e = rejectNonEssentialButton[0];
        if ("click" in e && typeof e.click == "function") {
          e.click();
        }
      }
    }, 500);
  };

  // Debounced navigation handler to prevent rapid-fire calls
  let navigationTimeout = null;
  const handleNavigation = () => {
    console.log("[RECLAIM] handleNavigation called, url:", window.location.href);
    keepClickingInterruptingButtons();

    // Clear any pending execution
    if (navigationTimeout) {
      clearTimeout(navigationTimeout);
    }

    const delay = Math.random() * 1000 + 500;
    navigationTimeout = setTimeout(processData, delay);
  };

  // Patch history in a less obvious way
  if (window.history && window.history.pushState) {
    const originalPush = window.history.pushState;
    window.history.pushState = function (...args) {
      originalPush.apply(this, args);
      handleNavigation();
    };

    const originalReplace = window.history.replaceState;
    window.history.replaceState = function (...args) {
      originalReplace.apply(this, args);
      handleNavigation();
    };
  }

  // Handle popstate
  window.addEventListener("popstate", handleNavigation, { passive: true });

  // Initial run with delay
  if (document.readyState === "complete") {
    handleNavigation();
  } else {
    window.addEventListener("load", handleNavigation, { once: true, passive: true });
  }
})();
