// Polyfills for browser and service worker environments
import { Buffer } from "buffer";
import process from "process";
import { debugLogger, DebugLogType } from "./logger";

// Skip WebSocket import for content script
// import { WebSocket } from './websocket-polyfill';

// Define a safe global object that works across environments
const getGlobalObject = () => {
  if (typeof window !== "undefined") return window;
  if (typeof self !== "undefined") return self;
  if (typeof global !== "undefined") return global;
  return Function("return this")();
};

// Get the global object
const global = getGlobalObject();

// Check if we're in a service worker or browser environment
const isServiceWorker = typeof window === "undefined";
// Determine if we're in content script context
const isContentScript = typeof document !== "undefined" && document.contentType !== undefined;

// Make Buffer and process available globally
global.Buffer = global.Buffer || Buffer;
global.process = global.process || process;

// Don't add WebSocket polyfill in content script context
if (typeof global.WebSocket === "undefined" && !isContentScript) {
  // Dynamically import WebSocket only when needed and not in content script
  try {
    const { WebSocket } = require("./websocket-polyfill");
    global.WebSocket = WebSocket;
    debugLogger.info(DebugLogType.POLYFILLS, "WebSocket polyfill added to global");
  } catch (e) {
    debugLogger.warn(DebugLogType.POLYFILLS, "Failed to load WebSocket polyfill:", e);
  }
} else {
  if (!isContentScript) {
    debugLogger.info(DebugLogType.POLYFILLS, "Using native WebSocket implementation");
  } else {
    debugLogger.info(DebugLogType.POLYFILLS, "Skipping WebSocket in content script context");
  }
}

// Force browser mode for Node.js compatibility
if (global.process) {
  global.process.browser = true;
}

// Handle Node.js-style require for libraries expecting WebSocket
if (typeof global.require !== "function") {
  global.require = (moduleName) => {
    // Return mock implementations for common modules
    switch (moduleName) {
      case "ws":
        // Don't return WebSocket in content script context
        if (isContentScript) {
          debugLogger.info(DebugLogType.POLYFILLS, "Blocking ws module in content script");
          return {}; // Empty implementation for content script
        }
        try {
          const { WebSocket } = require("./websocket-polyfill");
          return { WebSocket }; // Return our polyfill for ws
        } catch (e) {
          debugLogger.warn(DebugLogType.POLYFILLS, "Failed to load WebSocket for ws module:", e);
          return {};
        }
      case "fs":
        return global.fs;
      case "path":
        return global.path;
      case "os":
        return global.os;
      case "crypto":
        return global.crypto;
      case "worker_threads":
        return {}; // Empty implementation
      case "koffi":
      case "re2":
        return {}; // Empty implementation
      default:
        console.warn(`Mock require called for module: ${moduleName}`);
        return {};
    }
  };
} else {
  // Don't override require if it's already defined
  const originalRequire = global.require;
  global.require = (moduleName) => {
    if (moduleName === "ws") {
      // Don't return WebSocket in content script context
      if (isContentScript) {
        debugLogger.info(DebugLogType.POLYFILLS, "Blocking ws module in content script");
        return {}; // Empty implementation for content script
      }
      try {
        const { WebSocket } = require("./websocket-polyfill");
        return { WebSocket }; // Return our polyfill for ws
      } catch (e) {
        debugLogger.warn(DebugLogType.POLYFILLS, "Failed to load WebSocket for ws module:", e);
        return {};
      }
    }
    try {
      return originalRequire(moduleName);
    } catch (e) {
      debugLogger.warn(DebugLogType.POLYFILLS, `Failed to require module: ${moduleName}`);
      return {};
    }
  };
}

// Fix for snarkjs which tries to access process.browser
if (typeof process !== "undefined") {
  process.browser = true;

  // Add missing process properties that some modules might need
  if (!process.version) process.version = "v16.0.0"; // Mock Node.js version
  if (!process.cwd) process.cwd = () => "/"; // Mock current working directory
}

// TextEncoder and TextDecoder are available in both browser and service worker
if (typeof global.TextEncoder === "undefined" && !isServiceWorker) {
  const encoding = require("text-encoding");
  global.TextEncoder = encoding.TextEncoder;
  global.TextDecoder = encoding.TextDecoder;
}

// Handle other Node.js-specific functionality
if (typeof global.global === "undefined") {
  global.global = global;
}

// Handle crypto.getRandomValues polyfill if needed
if (typeof global.crypto === "undefined") {
  global.crypto = {};
}

if (typeof global.crypto.getRandomValues === "undefined") {
  global.crypto.getRandomValues = function (arr) {
    const bytes = new Uint8Array(arr.length);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  };
}

// Handle other potential missing WebCrypto APIs
if (typeof global.crypto.subtle === "undefined") {
  debugLogger.warn(DebugLogType.POLYFILLS, "WebCrypto subtle API not available. Some functionality may not work.");
  // Create a minimal fallback for subtle crypto
  global.crypto.subtle = {
    digest: async (algorithm, data) => {
      debugLogger.warn(DebugLogType.POLYFILLS, `Crypto subtle digest (${algorithm}) called with browser fallback`);
      // This is just a minimal fallback - not secure for production
      const hashInt = Array.from(new Uint8Array(data)).reduce((acc, val) => (acc * 31 + val) & 0xffffffff, 0);

      // Convert to a byte array of appropriate length
      const result = new Uint8Array(32); // SHA-256 length
      for (let i = 0; i < 32; i++) {
        result[i] = (hashInt >> (i * 8)) & 0xff;
      }

      return result.buffer;
    },
  };
}

// Only add browser-specific polyfills if we're in a browser
if (!isServiceWorker) {
  // Mock for Node.js domain module that attestor-core might use
  if (typeof global.domain === "undefined") {
    global.domain = {
      create: () => ({
        run: (fn) => fn(),
        on: () => {
          /* Empty function implementation */
        },
        bind: (fn) => fn,
      }),
    };
  }

  // Override URL constructor to handle node:url protocol
  const OriginalURL = global.URL;
  function CustomURL(url, base) {
    // Handle node:url protocol
    if (typeof url === "string" && url.startsWith("node:")) {
      url = url.replace(/^node:/, "");
    }
    return new OriginalURL(url, base);
  }

  // Copy prototype and static methods safely
  CustomURL.prototype = OriginalURL.prototype;
  try {
    // Try to copy static properties, but don't fail if they're read-only
    Object.getOwnPropertyNames(OriginalURL).forEach((prop) => {
      if (prop !== "prototype" && prop !== "constructor") {
        try {
          CustomURL[prop] = OriginalURL[prop];
        } catch (e) {
          // Silently ignore errors for read-only properties
        }
      }
    });
  } catch (e) {
    debugLogger.warn(DebugLogType.POLYFILLS, "Could not copy all URL static properties:", e);
  }

  // Set the global URL to our custom implementation
  try {
    global.URL = CustomURL;
  } catch (e) {
    debugLogger.warn(DebugLogType.POLYFILLS, "Could not override URL constructor:", e);
    // If we can't override the URL constructor, we'll have to live with the original
  }
}

// Mock for Node.js module.require which some libraries might use
if (typeof global.module === "undefined") {
  global.module = { exports: {} };
}

// Add missing fs functions that might be needed
global.fs = global.fs || {
  readFileSync: (path) => {
    debugLogger.warn(DebugLogType.POLYFILLS, `Attempted to readFileSync: ${path}`);
    throw new Error("fs.readFileSync is not available in this environment");
  },
  writeFileSync: (path, data) => {
    debugLogger.warn(DebugLogType.POLYFILLS, `Attempted to writeFileSync: ${path}`);
    // No-op
  },
  existsSync: (path) => {
    debugLogger.warn(DebugLogType.POLYFILLS, `Attempted to check if file exists: ${path}`);
    return false;
  },
  promises: {
    readFile: async (path) => {
      debugLogger.warn(DebugLogType.POLYFILLS, `Attempted to readFile: ${path}`);
      throw new Error("fs.promises.readFile is not available in this environment");
    },
    writeFile: async (path, data) => {
      debugLogger.warn(DebugLogType.POLYFILLS, `Attempted to writeFile: ${path}`);
      // No-op
    },
  },
};

// Add missing os functions
global.os = global.os || {
  tmpdir: () => "/tmp",
  homedir: () => "/home/user",
  platform: () => "browser",
  type: () => "Browser",
  cpus: () => [{ model: "Browser CPU", speed: 1000 }],
  totalmem: () => 8 * 1024 * 1024 * 1024, // 8GB
  freemem: () => 4 * 1024 * 1024 * 1024, // 4GB
};

// Ensure path methods are available
global.path = global.path || {
  join: (...args) => args.join("/").replace(/\/+/g, "/"),
  resolve: (...args) => args.join("/").replace(/\/+/g, "/"),
  dirname: (path) => path.split("/").slice(0, -1).join("/") || ".",
  basename: (path, ext) => {
    let base = path.split("/").pop() || "";
    if (ext && base.endsWith(ext)) {
      base = base.slice(0, -ext.length);
    }
    return base;
  },
  extname: (path) => {
    const base = path.split("/").pop() || "";
    const dotIndex = base.lastIndexOf(".");
    return dotIndex < 0 ? "" : base.slice(dotIndex);
  },
  sep: "/",
};

// Export for module imports
export default {
  Buffer,
  process,
};
