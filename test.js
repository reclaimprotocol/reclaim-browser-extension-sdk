// Build a lookup map for asset IDs

alert("started");
window.Reclaim.canExpectManyClaims(true);

// Auto-navigation to trade history
const steamId = "Sa2199"; // You can make this dynamic based on logged-in user

const checkAndNavigate = () => {
  const currentUrl = window.location.pathname;

  // Check if user is NOT on login/home and NOT already on tradehistory
  if (!currentUrl.includes("/login/home/") && !currentUrl.includes("/tradehistory/")) {
    // Navigate to trade history page
    const targetUrl = `/id/${steamId}/tradehistory/`;
    console.log(`Navigating to trade history: ${targetUrl}`);
    window.location.href = targetUrl;
  }
};

// Set interval to check every 2 seconds
const navigationInterval = setInterval(checkAndNavigate, 2000);

// Optional: Clear interval after successful navigation to trade history
if (window.location.pathname.includes("/tradehistory/")) {
  clearInterval(navigationInterval);
}

window.reclaimInterceptor.addResponseMiddleware(async (response, request) => {
  try {
    let requestUrl = request.url;
    if (typeof requestUrl !== "string") {
      if (typeof requestUrl === "object" && "url" in requestUrl) {
        requestUrl = requestUrl.url;
      } else {
        requestUrl = requestUrl || "/";
      }
    }
    const url = requestUrl.startsWith("/") ? window.location.origin + request.url : request.url;

    const checkUrl = `/id/${steamId}/tradehistory/`;

    if (url.includes(checkUrl)) {
      console.log("Response from trade history:", response);
    } else {
      console.log("Response from other url:", response);
    }
  } catch (error) {
    console.error("Error in reclaimInterceptor", error);
  }
});
