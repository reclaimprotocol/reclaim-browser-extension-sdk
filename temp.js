window.addEventListener("load", function () {
  // Run the inner function every 5000 milliseconds (5 seconds)
  setInterval(function () {
    const targetUrlPattern =
      /^https:\/\/www\.linkedin\.com\/mypreferences\/[^\/]+\/premium-manage-account/;

    // 1. Check if the current URL starts with the specified path
    // - Mobile url: https://www.linkedin.com/mypreferences/m/premium-manage-account
    // - Desktop url: https://www.linkedin.com/mypreferences/d/premium-manage-account
    if (targetUrlPattern.test(window.location.href)) {
      window.Reclaim.log("info", "Checking whether user has subscription");

      // 2. Search the document for any element with the target data attribute
      const cancelSubscriptionElement = document.querySelector(
        '[data-control-name="cancel_subscription"]',
      );

      window.Reclaim.log(
        "info",
        `Did find subscription cancel button: ${cancelSubscriptionElement}`,
      );

      // 3. If the element doesn't exists, execute the Reclaim function
      if (!cancelSubscriptionElement) {
        window.Reclaim.reportProviderError("You do not have a linkedin membership");
      }
    }
  }, 3000);
});
