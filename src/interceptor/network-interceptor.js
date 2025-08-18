/* eslint-disable @typescript-eslint/no-this-alias */

(function () {
  console.log("NETWORK INTERCEPTOR!!! LOADED!!!!");

  const injectionFunction = function () {
    /**
     * Debug utility for consistent logging across the interceptor
     * @type {Object}
     */
    const debug = {
      log: (...args) => console.log("🔍 [Debug]:", ...args),
      error: (...args) => console.error("❌ [Error]:", ...args),
      info: (...args) => console.info("ℹ️ [Info]:", ...args),
      // log: (...args) => undefined, // Disabled console.log("🔍 [Debug]:", ...args),
      // error: (...args) => undefined, // Disabled console.error("❌ [Error]:", ...args),
      // info: (...args) => undefined, // Disabled console.info("ℹ️ [Info]:", ...args),
    };

    /**
     * RequestInterceptor class
     * Provides middleware-based interception for both Fetch and XMLHttpRequest
     * Allows monitoring and modification of HTTP requests and responses
     */
    class RequestInterceptor {
      /**
       * Initialize the interceptor with empty middleware arrays and store original methods
       */
      constructor() {
        this.requestMiddlewares = [];
        this.responseMiddlewares = [];

        // Store original methods before overriding
        this.originalFetch = window.fetch?.bind(window);
        this.originalXHR = window.XMLHttpRequest;

        // Verify browser environment and required APIs
        if (typeof window === "undefined" || !this.originalFetch || !this.originalXHR) {
          debug.error("Not in a browser environment or required APIs not available");
          return;
        }

        this.setupInterceptor();
        debug.info("RequestInterceptor initialized");
      }

      /**
       * Process all request middlewares in parallel
       * @param {Object} requestData - Contains url and options for the request
       * @returns {Promise} - Resolves when all middlewares complete
       */
      async processRequestMiddlewares(requestData) {
        try {
          // Run all request middlewares in parallel
          await Promise.all(this.requestMiddlewares.map((middleware) => middleware(requestData)));
        } catch (error) {
          debug.error("Error in request middleware:", error);
        }
      }

      /**
       * Process response middlewares without blocking the main thread
       * @param {Response} response - The response object
       * @param {Object} requestData - The original request data
       */
      async processResponseMiddlewares(response, requestData) {
        const parsedResponse = await this.parseResponse(response);

        for (const middleware of this.responseMiddlewares) {
          try {
            await middleware(parsedResponse, requestData);
          } catch (error) {
            debug.error("Error in response middleware:", error);
          }
        }
      }

      /**
       * Parse response data into a consistent string format
       * @param {Response} response - The response object to parse
       * @returns {Object} - Parsed response with standardized format
       */
      async parseResponse(response) {
        const clone = response.clone();
        let responseBody;

        try {
          responseBody = await clone.text();
        } catch (error) {
          debug.error("Error parsing response:", error);
          responseBody = "Could not read response body";
        }

        return {
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
          originalResponse: response,
        };
      }

      /**
       * Set up interception for both Fetch and XMLHttpRequest
       * This method overrides the global fetch and XMLHttpRequest objects
       */
      setupInterceptor() {
        // Setup Fetch interceptor using a Proxy
        const originalFetch = this.originalFetch;
        const self = this;

        // Create a proxy for the fetch function
        window.fetch = new Proxy(originalFetch, {
          apply: async function (target, thisArg, argumentsList) {
            const [url, options = {}] = argumentsList;

            if (!url) {
              return Reflect.apply(target, thisArg, argumentsList);
            }

            const requestData = {
              url,
              options: {
                ...options,
                method: options.method || "GET",
                headers: options.headers || {},
              },
            };

            // Add a marker property to the request
            Object.defineProperty(requestData, "_rc", {
              value: true,
              enumerable: false,
              configurable: false,
              writable: false,
            });

            try {
              // Process request middlewares
              await Promise.all(
                self.requestMiddlewares.map((middleware) => middleware(requestData)),
              );
            } catch (error) {
              debug.error("Error in request middleware:", error);
            }

            // Make the actual fetch call with potentially modified data
            const response = await Reflect.apply(target, thisArg, [
              requestData.url,
              requestData.options,
            ]);

            // FIX: Don't create a prototype-chained response, use the original
            // Just mark it non-destructively
            if (!response._rc) {
              // Only mark it if not already marked
              try {
                Object.defineProperty(response, "_rc", {
                  value: true,
                  enumerable: false,
                  configurable: false,
                  writable: false,
                });
              } catch (e) {
                // In case the response is immutable, don't break the app
                debug.error("Could not mark response:", e);
              }
            }

            // Process response middlewares without blocking
            self.processResponseMiddlewares(response.clone(), requestData).catch((error) => {
              debug.error("Error in response middleware:", error);
            });
            return response; // Return the original response object
          },
        });

        // Setup XHR interceptor by modifying the prototype
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        // Create a WeakMap to store request info for each XHR instance
        const requestInfoMap = new WeakMap();

        // Modify open method on prototype
        XMLHttpRequest.prototype.open = function (...args) {
          // Mark this instance as intercepted
          Object.defineProperty(this, "_rc", {
            value: true,
            enumerable: false,
            configurable: false,
            writable: false,
          });

          const [method = "GET", url = ""] = args;
          const requestInfo = {
            url,
            options: {
              method,
              headers: {},
              body: null,
            },
          };

          // Store request info in WeakMap
          requestInfoMap.set(this, requestInfo);

          // Call original method
          return originalOpen.apply(this, args);
        };

        // Modify setRequestHeader method on prototype
        XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
          const requestInfo = requestInfoMap.get(this);
          if (requestInfo && header && value) {
            requestInfo.options.headers[header] = value;
          }
          return originalSetRequestHeader.apply(this, arguments);
        };

        // Modify send method on prototype
        XMLHttpRequest.prototype.send = function (data) {
          const requestInfo = requestInfoMap.get(this);
          if (requestInfo) {
            requestInfo.options.body = data;

            // Process request middlewares
            const runRequestMiddlewares = async () => {
              try {
                await Promise.all(
                  self.requestMiddlewares.map((middleware) => middleware(requestInfo)),
                );
              } catch (error) {
                debug.error("Error in request middleware:", error);
              }
            };

            // Store original onreadystatechange
            const originalHandler = this.onreadystatechange;

            // Override onreadystatechange
            this.onreadystatechange = function (event) {
              if (typeof originalHandler === "function") {
                originalHandler.apply(this, arguments);
              }

              if (this.readyState === 4) {
                const status = this.status || 500;
                const statusText = this.statusText || "Request Failed";

                try {
                  /**
                   * Helper function to convert any response type to string
                   * @param {*} response - The XHR response which could be:
                   * - string (for responseType '' or 'text')
                   * - object (for responseType 'json')
                   * - Blob (for responseType 'blob')
                   * - ArrayBuffer (for responseType 'arraybuffer')
                   * - Document (for responseType 'document')
                   * @returns {string} The response as a string
                   */
                  const getResponseString = (response) => {
                    if (response === null || response === undefined) {
                      return "";
                    }

                    // Handle different response types
                    switch (typeof response) {
                      case "string":
                        return response;
                      case "object":
                        // Handle special response types
                        if (response instanceof Blob || response instanceof ArrayBuffer) {
                          return "[Binary Data]";
                        }
                        if (response instanceof Document) {
                          return response.documentElement.outerHTML;
                        }
                        // For plain objects or arrays
                        try {
                          return JSON.stringify(response);
                        } catch (e) {
                          debug.error("Failed to stringify object response:", e);
                          return String(response);
                        }
                      default:
                        return String(response);
                    }
                  };

                  const responseObj = new Response(getResponseString(this.response), {
                    status: status,
                    statusText: statusText,
                    headers: new Headers(
                      Object.fromEntries(
                        (this.getAllResponseHeaders() || "")
                          .split("\r\n")
                          .filter(Boolean)
                          .map((line) => line.split(": ")),
                      ),
                    ),
                  });

                  Object.defineProperty(responseObj, "url", {
                    value: requestInfo.url,
                    writable: false,
                  });

                  // Process response middlewares
                  self
                    .processResponseMiddlewares(responseObj, requestInfo)
                    .catch((error) => debug.error("Error in response middleware:", error));
                } catch (error) {
                  debug.error("Error processing XHR response:", error);
                }
              }
            };

            // Run middlewares then send
            runRequestMiddlewares().then(() => {
              originalSend.call(this, requestInfo.options.body);
            });
          } else {
            // Handle case where open wasn't called first
            originalSend.apply(this, arguments);
          }
        };

        // Reset functionality to restore original methods if needed
        this.resetXHRInterceptor = function () {
          XMLHttpRequest.prototype.open = originalOpen;
          XMLHttpRequest.prototype.send = originalSend;
          XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
        };
      }

      /**
       * Add a middleware function to process requests before they are sent
       * @param {Function} middleware - Function to process request data
       */
      addRequestMiddleware(middleware) {
        if (typeof middleware === "function") {
          this.requestMiddlewares.push(middleware);
        }
      }

      /**
       * Add a middleware function to process responses after they are received
       * @param {Function} middleware - Function to process response data
       */
      addResponseMiddleware(middleware) {
        if (typeof middleware === "function") {
          this.responseMiddlewares.push(middleware);
        }
      }
    }

    // Create instance of the interceptor
    const interceptor = new RequestInterceptor();

    // Request middleware for capturing and sending requests to content script
    interceptor.addRequestMiddleware(async (request) => {
      //   debug.info("Request:", {
      //       url: request.url,
      //       method: request.options.method,
      //       headers: request.options.headers,
      //   });

      // Create a completely new object with only primitive values
      try {
        // Safely extract headers as a plain object
        let headersObj = {};
        try {
          if (request.options.headers) {
            if (request.options.headers instanceof Headers) {
              headersObj = Object.fromEntries(request.options.headers.entries());
            } else if (typeof request.options.headers === "object") {
              // Only copy string values from headers
              Object.keys(request.options.headers).forEach((key) => {
                const val = request.options.headers[key];
                if (typeof val === "string" || typeof val === "number") {
                  headersObj[key] = String(val);
                }
              });
            }
          }
        } catch (e) {
          debug.error("Error extracting headers:", e);
        }

        // Safely extract body
        let bodyStr = null;
        try {
          if (request.options.body) {
            if (typeof request.options.body === "string") {
              bodyStr = request.options.body;
            } else if (typeof request.options.body === "object") {
              bodyStr = JSON.stringify(request.options.body);
            }
          }
        } catch (e) {
          debug.error("Error extracting body:", e);
        }

        // Safely extract URL as a plain string
        let urlStr = "";
        try {
          if (typeof request.url === "string") {
            urlStr = request.url.startsWith("http")
              ? request.url
              : new URL(request.url, window.location.origin).href;
          } else if (request.url && typeof request.url === "object" && request.url.url) {
            // Handle Request object
            urlStr = request.url.url;
          } else if (request.url && typeof request.url === "object" && request.url.href) {
            // Handle URL object
            urlStr = request.url.href;
          } else {
            // Fallback - try to get URL from the object
            urlStr = String(request.url);
            if (!urlStr.startsWith("http")) {
              urlStr = new URL(urlStr, window.location.origin).href;
            }
          }
        } catch (e) {
          debug.error("Error extracting URL:", e);
          urlStr = window.location.href; // Fallback to current page URL
        }

        // Create a simple, serializable object
        const simpleRequest = {
          url: urlStr,
          method: typeof request.options.method === "string" ? request.options.method : "GET",
          headers: headersObj,
          body: bodyStr,
        };

        // Send the simplified request data
        window.postMessage(
          {
            action: "INTERCEPTED_REQUEST",
            data: simpleRequest,
          },
          "*",
        );
      } catch (error) {
        debug.error("Error posting request data:", error);
        // Send minimal data as fallback
        let fallbackUrl = "";
        try {
          if (typeof request.url === "string") {
            fallbackUrl = request.url.startsWith("http")
              ? request.url
              : new URL(request.url, window.location.origin).href;
          } else if (request.url && typeof request.url === "object" && request.url.url) {
            fallbackUrl = request.url.url;
          } else if (request.url && typeof request.url === "object" && request.url.href) {
            fallbackUrl = request.url.href;
          } else {
            fallbackUrl = window.location.href;
          }
        } catch (e) {
          fallbackUrl = window.location.href;
        }

        window.postMessage(
          {
            action: "INTERCEPTED_REQUEST",
            data: {
              url: fallbackUrl,
              method: typeof request.options.method === "string" ? request.options.method : "GET",
              headers: {},
              body: null,
            },
          },
          "*",
        );
      }
    });

    // Response middleware for capturing and sending responses to content script
    interceptor.addResponseMiddleware(async (response, request) => {
      // debug.info("Response:", {
      //   url: request.url,
      //   status: response.status,
      //   body: response.body,
      // });

      // Create a completely new object with only primitive values
      try {
        // Safely extract headers as a plain object
        let headersObj = {};
        try {
          if (response.headers) {
            if (response.headers instanceof Headers) {
              headersObj = Object.fromEntries(response.headers.entries());
            } else if (typeof response.headers === "object") {
              // Only copy string values from headers
              Object.keys(response.headers).forEach((key) => {
                const val = response.headers[key];
                if (typeof val === "string" || typeof val === "number") {
                  headersObj[key] = String(val);
                }
              });
            }
          }
        } catch (e) {
          debug.error("Error extracting headers:", e);
        }

        // Safely extract body
        let bodyStr = null;
        try {
          if (response.body) {
            if (typeof response.body === "string") {
              bodyStr = response.body;
            } else if (typeof response.body === "object") {
              bodyStr = JSON.stringify(response.body);
            }
          }
        } catch (e) {
          debug.error("Error extracting body:", e);
        }

        // Safely extract URL as a plain string
        let urlStr = "";
        try {
          if (typeof request.url === "string") {
            urlStr = request.url.startsWith("http")
              ? request.url
              : new URL(request.url, window.location.origin).href;
          } else if (request.url && typeof request.url === "object" && request.url.url) {
            // Handle Request object
            urlStr = request.url.url;
          } else if (request.url && typeof request.url === "object" && request.url.href) {
            // Handle URL object
            urlStr = request.url.href;
          } else {
            // Fallback - try to get URL from the object
            urlStr = String(request.url);
            if (!urlStr.startsWith("http")) {
              urlStr = new URL(urlStr, window.location.origin).href;
            }
          }
        } catch (e) {
          debug.error("Error extracting URL:", e);
          urlStr = window.location.href; // Fallback to current page URL
        }

        // Create a simple, serializable object
        const simpleResponse = {
          url: urlStr,
          status: response.status,
          headers: headersObj,
          body: bodyStr,
        };

        // Send the simplified response data
        window.postMessage(
          {
            action: "INTERCEPTED_RESPONSE",
            data: simpleResponse,
          },
          "*",
        );
      } catch (error) {
        debug.error("Error posting response data:", error);
        // Send minimal data as fallback
        let fallbackUrl = "";
        try {
          if (typeof request.url === "string") {
            fallbackUrl = request.url.startsWith("http")
              ? request.url
              : new URL(request.url, window.location.origin).href;
          } else if (request.url && typeof request.url === "object" && request.url.url) {
            fallbackUrl = request.url.url;
          } else if (request.url && typeof request.url === "object" && request.url.href) {
            fallbackUrl = request.url.href;
          } else {
            fallbackUrl = window.location.href;
          }
        } catch (e) {
          fallbackUrl = window.location.href;
        }

        window.postMessage(
          {
            action: "INTERCEPTED_RESPONSE",
            data: {
              url: fallbackUrl,
              status: response.status,
              headers: {},
              body: null,
            },
          },
          "*",
        );
      }
    });

    /**
     * Expose the interceptor instance globally
     * This allows adding more middlewares from other scripts or the console
     *
     * Usage examples:
     *
     * // Add a request middleware
     * window.reclaimInterceptor.addRequestMiddleware(async (request) => {
     *   console.log('New request:', request.url);
     * });
     *
     * // Add a response middleware
     * window.reclaimInterceptor.addResponseMiddleware(async (response, request) => {
     *   console.log('New response:', response.body);
     * });
     */
    window.reclaimInterceptor = interceptor;

    debug.info("Userscript initialized and ready - Access via window.reclaimInterceptor");
  };

  injectionFunction();
})();
