/* eslint-disable @typescript-eslint/no-this-alias */

(function () {
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
        let responseBody;
        const url = response.url || "";
        const headersObj = Object.fromEntries(response.headers.entries());

        try {
          // Read ONCE from the audit copy we got.
          const raw = await response.text(); // don't do copy.json(); avoid double read
          responseBody = raw;
        } catch (e) {
          // Rescue path (below)
          responseBody = `[Error reading response: ${e?.name || e}]`;
        }

        return {
          id: response.id || null,
          url,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body: responseBody,
          originalResponse: response,
          timestamp: Date.now(),
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
                method: options?.method?.toUpperCase() || "GET",
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

            const { status, statusText } = response;
            const headers = new Headers(response.headers);

            // If there's no body (204, etc.), just pass-through
            if (!response.body) {
              self.processResponseMiddlewares(response.clone(), requestData).catch(debug.error);
              return response;
            }

            const [forAppStream, forAuditStream] = response.body.tee();
            const forApp = new Response(forAppStream, { status, statusText, headers });
            const forAudit = new Response(forAuditStream, { status, statusText, headers });

            // Start parsing ASAP; don't clone forAudit again
            self.processResponseMiddlewares(forAudit, requestData).catch(debug.error);

            // Return the app's branch
            return forApp;

            // FIX: Don't create a prototype-chained response, use the original
            // Just mark it non-destructively
            // if (!response._rc) {
            //   // Only mark it if not already marked
            //   try {
            //     Object.defineProperty(response, "_rc", {
            //       value: true,
            //       enumerable: false,
            //       configurable: false,
            //       writable: false,
            //     });
            //   } catch (e) {
            //     // In case the response is immutable, don't break the app
            //     debug.error("Could not mark response:", e);
            //   }
            // }

            // // Process response middlewares without blocking
            // self.processResponseMiddlewares(response.clone(), requestData).catch((error) => {
            //   debug.error("Error in response middleware:", error);
            // });
            // return response; // Return the original response object
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
                  console.log("error", error);
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

    interceptor.addResponseMiddleware(async (response, request) => {
      try {
        // Helper function to safely extract headers
        const extractHeaders = (headers) => {
          let headersObj = {};
          try {
            if (headers) {
              if (headers instanceof Headers) {
                headersObj = Object.fromEntries(headers.entries());
              } else if (typeof headers === "object") {
                Object.keys(headers).forEach((key) => {
                  const val = headers[key];
                  if (typeof val === "string" || typeof val === "number") {
                    headersObj[key] = String(val);
                  }
                });
              }
            }
          } catch (e) {
            debug.error("Error extracting headers:", e);
          }
          return headersObj;
        };

        // Helper function to safely extract body
        const extractBody = (body) => {
          let bodyStr = null;
          try {
            if (body) {
              if (typeof body === "string") {
                bodyStr = body;
              } else if (typeof body === "object") {
                bodyStr = JSON.stringify(body);
              }
            }
          } catch (e) {
            debug.error("Error extracting body:", e);
          }
          return bodyStr;
        };

        // Helper function to safely extract URL
        const extractUrl = (url) => {
          let urlStr = "";
          try {
            if (typeof url === "string") {
              urlStr = url.startsWith("http") ? url : new URL(url, window.location.origin).href;
            } else if (url && typeof url === "object" && url.url) {
              urlStr = url.url;
            } else if (url && typeof url === "object" && url.href) {
              urlStr = url.href;
            } else {
              urlStr = String(url);
              if (!urlStr.startsWith("http")) {
                urlStr = new URL(urlStr, window.location.origin).href;
              }
            }
          } catch (e) {
            debug.error("Error extracting URL:", e);
            urlStr = window.location.href;
          }
          return urlStr;
        };

        // Extract URL once for both request and response
        const url = extractUrl(request.url);

        // Create combined request/response object
        const combinedData = {
          request: {
            url: url,
            method:
              typeof request.options.method === "string"
                ? request.options.method?.toUpperCase()
                : "GET",
            headers: extractHeaders(request.options.headers),
            body: extractBody(request.options.body),
          },
          response: {
            url: url,
            status: response.status,
            headers: extractHeaders(response.headers),
            body: extractBody(response.body),
          },
          timestamp: Date.now(),
        };

        // Send the combined data
        window.postMessage(
          {
            action: "INTERCEPTED_REQUEST_AND_RESPONSE",
            data: combinedData,
          },
          "*",
        );
      } catch (error) {
        debug.error("Error processing request/response:", error);

        // Fallback with minimal data
        window.postMessage(
          {
            action: "INTERCEPTED_REQUEST_AND_RESPONSE",
            data: {
              url: window.location.href,
              request: {
                method: "GET",
                headers: {},
                body: null,
              },
              response: {
                status: response.status || 0,
                headers: {},
                body: null,
              },
              timestamp: Date.now(),
              error: error.message,
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
