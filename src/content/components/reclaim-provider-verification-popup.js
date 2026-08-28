export function createProviderVerificationPopup(
  providerName,
  description,
  dataRequired,
  sessionId,
) {
  // Inject CSS styles directly instead of importing them
  injectStyles();

  const popup = document.createElement("div");
  popup.id = "reclaim-protocol-popup";
  popup.className = "reclaim-popup";
  popup.style.animation = "reclaim-appear 0.3s ease-out";

  // Track the state of claim generation
  const state = {
    totalClaims: 0,
    completedClaims: 0,
    proofSubmitted: false,
    inProgress: false,
    error: null,
  };

  // Drag state
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  renderInitialContent().then(() => {
    initializeDragFunctionality();
    initializeCopyFunctionality();
    initializeTooltipFunctionality();
  });

  // Drag and copy functionality will be initialized after content is rendered

  async function loadCSS() {
    // Check if styles are already injected
    if (document.getElementById("reclaim-popup-styles")) {
      return;
    }

    try {
      const cssUrl = chrome.runtime.getURL(
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
      );
      const response = await fetch(cssUrl);
      const cssText = await response.text();

      const styleEl = document.createElement("style");
      styleEl.id = "reclaim-popup-styles";
      styleEl.textContent = cssText;

      // Handle document.head not being available yet
      const appendStyle = () => {
        if (document.head) {
          document.head.appendChild(styleEl);
        } else if (document.body) {
          document.body.appendChild(styleEl);
        } else {
          // If neither head nor body is available, try again later
          setTimeout(appendStyle, 10);
        }
      };

      appendStyle();
    } catch (error) {
      console.error("Failed to load Reclaim popup CSS:", error);
    }
  }

  async function loadHTMLTemplate() {
    try {
      const htmlUrl = chrome.runtime.getURL(
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.html",
      );
      const response = await fetch(htmlUrl);
      const htmlText = await response.text();
      return htmlText;
    } catch (error) {
      console.error("Failed to load Reclaim popup HTML template:", error);
      return "";
    }
  }

  function injectStyles() {
    loadCSS();
  }

  async function renderInitialContent() {
    const htmlTemplate = await loadHTMLTemplate();

    if (!htmlTemplate) {
      console.error("Failed to load HTML template - popup will not render correctly");
      return;
    }

    // Replace template placeholders with actual values.
    //
    // `description` and `dataRequired` no longer appear in the template — the
    // popup shows the session id and the verification status only. They stay in
    // the function signature because the background still sends them in
    // SHOW_PROVIDER_VERIFICATION_POPUP, and `providerName` is still used by the
    // "How it works" steps.
    const renderedHTML = htmlTemplate
      // .replace(/\{\{logoUrl\}\}/g, chrome.runtime.getURL("assets/img/logo.png"))
      .replace(/\{\{providerName\}\}/g, providerName)
      .replace(/\{\{sessionId\}\}/g, sessionId);

    popup.innerHTML = renderedHTML;
  }

  function initializeDragFunctionality() {
    const header = popup.querySelector(".reclaim-popup-header");

    function handleMouseDown(e) {
      // Only allow dragging on left mouse button
      if (e.button !== 0) return;

      isDragging = true;
      popup.classList.add("dragging");

      // Calculate offset from mouse position to popup top-left corner
      const rect = popup.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;

      // Prevent text selection while dragging
      e.preventDefault();

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    function handleMouseMove(e) {
      if (!isDragging) return;

      e.preventDefault();

      // Calculate new position
      let newX = e.clientX - dragOffset.x;
      let newY = e.clientY - dragOffset.y;

      // Get viewport dimensions
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const popupWidth = popup.offsetWidth;
      const popupHeight = popup.offsetHeight;

      newX = Math.max(0, Math.min(newX, viewportWidth - popupWidth));
      newY = Math.max(0, Math.min(newY, viewportHeight - popupHeight));

      // Update popup position
      popup.style.left = newX + "px";
      popup.style.top = newY + "px";
      popup.style.right = "auto";
      popup.style.bottom = "auto";
    }

    function handleMouseUp(e) {
      if (!isDragging) return;

      isDragging = false;
      popup.classList.remove("dragging");

      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    }

    header.addEventListener("mousedown", handleMouseDown);

    // Prevent context menu on header to avoid interference
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
  }

  function initializeCopyFunctionality() {
    const copyButton = popup.querySelector(".reclaim-copy-icon");
    const copyFeedback = popup.querySelector("#reclaim-copy-feedback");

    if (copyButton) {
      copyButton.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetId = copyButton.getAttribute("data-copy-target");
        const targetElement = popup.querySelector(`#${targetId}`);

        if (targetElement) {
          try {
            const textToCopy = targetElement.textContent.trim();

            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(textToCopy);
              showCopyFeedback("Copied!");
            } else {
              // Fallback for older browsers
              const textArea = document.createElement("textarea");
              textArea.value = textToCopy;
              textArea.style.position = "fixed";
              textArea.style.left = "-9999px";
              textArea.style.top = "-9999px";
              document.body.appendChild(textArea);
              textArea.focus();
              textArea.select();

              try {
                const successful = document.execCommand("copy");
                if (successful) {
                  showCopyFeedback("Copied!");
                } else {
                  showCopyFeedback("Failed to copy", true);
                }
              } catch (err) {
                showCopyFeedback("Failed to copy", true);
              }

              document.body.removeChild(textArea);
            }
          } catch (err) {
            showCopyFeedback("Failed to copy", true);
          }
        }
      });
    }

    function showCopyFeedback(message, isError = false) {
      if (copyFeedback) {
        copyFeedback.textContent = message;
        copyFeedback.style.color = isError ? "#ffffff" : "#ffffff";
        copyFeedback.style.background = isError
          ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
          : "linear-gradient(135deg, #10b981 0%, #059669 100%)";
        copyFeedback.classList.add("show");

        // Hide feedback after 2 seconds for more compact UX
        setTimeout(() => {
          copyFeedback.classList.remove("show");
        }, 2000);
      }
    }
  }

  function initializeTooltipFunctionality() {
    const infoValues = popup.querySelectorAll(".reclaim-info-value[data-tooltip]");

    infoValues.forEach((element) => {
      const tooltipText = element.getAttribute("data-tooltip");
      const displayText = element.textContent.trim();

      // Only show tooltip if text is truncated
      if (tooltipText && tooltipText.length > 25) {
        let tooltip = null;
        let hoverTimeout = null;

        function showTooltip() {
          if (!tooltip) {
            tooltip = document.createElement("div");
            tooltip.className = "reclaim-info-tooltip";
            tooltip.textContent = tooltipText;
            element.appendChild(tooltip);
          }

          tooltip.classList.add("show");
        }

        function hideTooltip() {
          if (tooltip) {
            tooltip.classList.remove("show");
          }
        }

        element.addEventListener("mouseenter", () => {
          clearTimeout(hoverTimeout);
          hoverTimeout = setTimeout(showTooltip, 500);
        });

        element.addEventListener("mouseleave", () => {
          clearTimeout(hoverTimeout);
          hideTooltip();
        });

        // Also show tooltip on click for mobile
        element.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tooltip && tooltip.classList.contains("show")) {
            hideTooltip();
          } else {
            showTooltip();
          }
        });
      }
    });

    // Hide all tooltips when clicking outside
    document.addEventListener("click", () => {
      const tooltips = popup.querySelectorAll(".reclaim-info-tooltip.show");
      tooltips.forEach((tooltip) => {
        tooltip.classList.remove("show");
      });
    });
  }

  function showLoader(message = "Generating verification proof...") {
    const stepsContainer = popup.querySelector("#reclaim-steps-container");
    const statusContainer = popup.querySelector("#reclaim-status-container");
    const circularLoader = popup.querySelector("#reclaim-circular-loader");
    const progressContainer = popup.querySelector("#reclaim-status-progress");
    const statusText = popup.querySelector("#reclaim-status-text");
    const successIcon = popup.querySelector("#reclaim-success-icon");
    const errorIcon = popup.querySelector("#reclaim-error-icon");
    const contentContainer = popup.querySelector(".reclaim-popup-content");

    // Hide the steps using CSS classes instead of style manipulation
    if (stepsContainer) {
      stepsContainer.classList.add("hidden");
    }

    // Hide status icons
    if (successIcon) {
      successIcon.style.display = "none";
    }
    if (errorIcon) {
      errorIcon.style.display = "none";
    }

    statusContainer.classList.add("visible");
    contentContainer.classList.add("status-active");
    circularLoader.style.display = "flex";
    progressContainer.style.display = "block";
    statusText.textContent = message;

    state.inProgress = true;
    updateProgressBar();
  }

  function updateProgressBar() {
    const progressBar = popup.querySelector("#reclaim-progress-bar");
    const progressCounter = popup.querySelector("#reclaim-progress-counter");

    if (state.totalClaims > 0) {
      // Clamped: the fallback increment path has no session-wide total to check
      // against, and a bar scaled past 1 (or a counter reading 4/3) is worse
      // than one that saturates.
      const completed = Math.min(state.completedClaims, state.totalClaims);
      const percentage = completed / state.totalClaims;
      // Use transform instead of width to avoid layout recalculations
      progressBar.style.transform = `scaleX(${percentage})`;
      progressCounter.textContent = `${completed}/${state.totalClaims}`;
    } else {
      progressBar.style.transform = "scaleX(1)";
      progressBar.style.animation = "reclaim-progress-pulse 2s infinite";
      progressCounter.textContent = "";
    }
  }

  function updateStatusMessage(message, isError = false) {
    const statusMessage = popup.querySelector("#reclaim-status-message");
    statusMessage.textContent = message;
    statusMessage.style.color = isError ? "#ef4444" : "rgba(255, 255, 255, 0.8)";
  }

  function showSuccess() {
    const stepsContainer = popup.querySelector("#reclaim-steps-container");
    const statusContainer = popup.querySelector("#reclaim-status-container");
    const circularLoader = popup.querySelector("#reclaim-circular-loader");
    const progressContainer = popup.querySelector("#reclaim-status-progress");
    const statusText = popup.querySelector("#reclaim-status-text");
    const progressBar = popup.querySelector("#reclaim-progress-bar");
    const progressCounter = popup.querySelector("#reclaim-progress-counter");
    const contentContainer = popup.querySelector(".reclaim-popup-content");

    // Hide the steps using CSS classes
    if (stepsContainer) {
      stepsContainer.classList.add("hidden");
    }

    circularLoader.style.display = "none";

    // Show success UI
    statusContainer.classList.add("visible");
    contentContainer.classList.add("status-active");
    progressContainer.style.display = "block";
    statusText.textContent = "Verification complete!";

    // Ensure progress bar is fully filled - use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
      progressBar.style.width = "100%";
      progressBar.style.transform = "scaleX(1)";
      progressBar.classList.add("success");
      progressBar.style.animation = "none";
    });

    // Update progress counter to show completion
    if (state.totalClaims > 0) {
      progressCounter.textContent = `${state.totalClaims}/${state.totalClaims}`;
    } else {
      progressCounter.textContent = "100%";
    }

    updateStatusMessage("You will be redirected to the original page shortly.");

    const successIcon = popup.querySelector("#reclaim-success-icon");
    const errorIcon = popup.querySelector("#reclaim-error-icon");
    if (successIcon) {
      successIcon.style.display = "flex";
    }
    if (errorIcon) {
      errorIcon.style.display = "none";
    }
  }

  function showError(errorMessage) {
    const stepsContainer = popup.querySelector("#reclaim-steps-container");
    const statusContainer = popup.querySelector("#reclaim-status-container");
    const circularLoader = popup.querySelector("#reclaim-circular-loader");
    const progressContainer = popup.querySelector("#reclaim-status-progress");
    const statusText = popup.querySelector("#reclaim-status-text");
    const progressBar = popup.querySelector("#reclaim-progress-bar");
    const contentContainer = popup.querySelector(".reclaim-popup-content");

    // Hide the steps using CSS classes
    if (stepsContainer) {
      stepsContainer.classList.add("hidden");
    }

    circularLoader.style.display = "none";

    // Show error UI
    statusContainer.classList.add("visible");
    contentContainer.classList.add("status-active");
    progressContainer.style.display = "block";
    statusText.textContent = "Verification failed";
    progressBar.style.transform = "scaleX(1)";
    progressBar.classList.add("error");
    progressBar.style.animation = "none";

    updateStatusMessage(errorMessage, true);

    const errorIcon = popup.querySelector("#reclaim-error-icon");
    const successIcon = popup.querySelector("#reclaim-success-icon");
    if (errorIcon) {
      errorIcon.style.display = "flex";
    }
    if (successIcon) {
      successIcon.style.display = "none";
    }
  }

  function incrementTotalClaims() {
    state.totalClaims += 1;
    updateProgressBar();
  }

  function incrementCompletedClaims() {
    state.completedClaims += 1;
    updateProgressBar();
  }

  /**
   * Adopt the background's session-wide counts, when it sends them.
   *
   * This popup is rebuilt from zero on every navigation, and a multi-request
   * provider spans several origins — so the local counters only ever describe
   * the current page. The background's numbers span the whole session.
   *
   * Falls back to the local increment when `progress` is absent, so an older
   * message shape (or a path that has not been given the counts) still moves
   * the bar rather than freezing it.
   *
   * @param {{completed: number, total: number}|undefined} progress
   * @param {() => void} fallback
   */
  function applyProgress(progress, fallback) {
    if (!progress || typeof progress.total !== "number") {
      fallback();
      return;
    }
    state.totalClaims = progress.total;
    state.completedClaims = Math.min(progress.completed ?? 0, progress.total);
    updateProgressBar();
  }

  // Expose the public API for the popup
  return {
    element: popup,
    showLoader,
    updateStatusMessage,
    showSuccess,
    showError,
    incrementTotalClaims,
    incrementCompletedClaims,

    // Handle various status updates from background
    handleClaimCreationRequested: (requestHash, progress) => {
      applyProgress(progress, incrementTotalClaims);
      showLoader("Creating verification claim...");
    },

    handleClaimCreationSuccess: (requestHash) => {
      updateStatusMessage("Claim created successfully. Generating proof...");
    },

    handleClaimCreationFailed: (requestHash) => {
      showError("Failed to create claim. Please try again.");
    },

    handleProofGenerationStarted: (requestHash) => {
      updateStatusMessage("Generating cryptographic proof...");
    },

    handleProofGenerationSuccess: (requestHash, progress) => {
      applyProgress(progress, incrementCompletedClaims);
      updateStatusMessage(`Proof generated (${state.completedClaims}/${state.totalClaims})`);
    },

    handleProofGenerationFailed: (requestHash) => {
      showError("Failed to generate proof. Please try again.");
    },

    handleProofSubmitted: () => {
      state.proofSubmitted = true;
      showSuccess();
    },

    handleProofSubmissionFailed: (error) => {
      showError(`Failed to submit proof: ${error}`);
    },
  };
}
