/**
 * Mock implementation for jsdom to avoid canvas dependency
 */

// Create minimal DOM-like objects
const createBasicDOM = () => {
  const document = {
    createElement: () => ({}),
    createElementNS: () => ({}),
    documentElement: { style: {} },
    implementation: {
      createHTMLDocument: () => document,
    },
  };

  const window = {
    document,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { href: "about:blank" },
    navigator: { userAgent: "MockBrowser" },
    HTMLElement: class {},
    HTMLCanvasElement: class {},
    Image: class {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  return { window, document };
};

// Export a simplified JSDOM API
module.exports = {
  JSDOM: class {
    constructor(html = "", options = {}) {
      const { window, document } = createBasicDOM();
      this.window = window;
      this.document = document;
    }

    // Helper to close and clean up (no-op in mock)
    close() {}

    // Convert to serialized HTML
    serialize() {
      return "<!DOCTYPE html><html><head></head><body></body></html>";
    }

    // Static method for creating virtual console
    static createVirtualConsole() {
      return {
        on: () => {},
        sendTo: () => {},
      };
    }
  },

  // Add constants and utilities
  VirtualConsole: class {
    on() {
      return this;
    }
    sendTo() {
      return this;
    }
  },

  CookieJar: class {
    setCookie() {
      return Promise.resolve();
    }
    getCookieString() {
      return Promise.resolve("");
    }
  },

  // No-op ResourceLoader
  ResourceLoader: class {
    fetch() {
      return Promise.resolve(Buffer.from(""));
    }
  },
};
