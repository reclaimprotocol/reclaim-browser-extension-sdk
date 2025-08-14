/**
 * WebSocket Polyfill
 * 
 * This module provides a WebSocket polyfill that uses the browser's native WebSocket when available
 * or provides a mock implementation for background scripts where window is not available.
 * It ensures compatibility with Node.js-style WebSocket usage patterns.
 */

// Check if we're in a context with window (browser/content script) or not (background script)
const isBackgroundContext = typeof window === 'undefined';
import { debugLogger, DebugLogType } from './logger';

// Create either a real WebSocket wrapper or a mock implementation
let WebSocketPolyfill;

if (!isBackgroundContext) {
  // Browser context - use the native WebSocket
  const BrowserWebSocket = window.WebSocket;
  
  WebSocketPolyfill = class extends BrowserWebSocket {
    constructor(url, protocols) {
      debugLogger.info(DebugLogType.POLYFILLS, '[WEBSOCKET-POLYFILL] Creating WebSocket with URL:', url);
      super(url, protocols);
      
      // Add event handling compatibility
      this.addEventListener('error', (event) => {
        if (typeof this.onerror === 'function') {
          this.onerror(event);
        }
      });
      
      this.addEventListener('open', (event) => {
        if (typeof this.onopen === 'function') {
          this.onopen(event);
        }
      });
      
      this.addEventListener('close', (event) => {
        if (typeof this.onclose === 'function') {
          this.onclose(event);
        }
      });
      
      this.addEventListener('message', (event) => {
        if (typeof this.onmessage === 'function') {
          this.onmessage(event);
        }
      });
    }
    
    // Add a promise-based send method expected by some libraries
    sendPromise(data) {
      return new Promise((resolve, reject) => {
        try {
          this.send(data);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    }
  };
  
  debugLogger.info(DebugLogType.POLYFILLS, '[WEBSOCKET-POLYFILL] Using browser WebSocket implementation');
} else {
  // Background script context - create a mock implementation
  WebSocketPolyfill = class {
    constructor(url, protocols) {
      debugLogger.info(DebugLogType.POLYFILLS, '[WEBSOCKET-POLYFILL] Creating mock WebSocket for background context');
      this.url = url;
      this.protocols = protocols;
      this.readyState = 3; // CLOSED
      
      // Simulate being closed immediately
      setTimeout(() => {
        if (typeof this.onclose === 'function') {
          this.onclose({ code: 1000, reason: 'WebSockets not supported in background context' });
        }
      }, 0);
    }
    
    // No-op methods
    send() {
      debugLogger.warn(DebugLogType.POLYFILLS, '[WEBSOCKET-POLYFILL] Cannot use WebSockets in background context');
      throw new Error('WebSockets are not available in background context');
    }
    
    close() {
      // Already closed, no-op
    }
    
    sendPromise() {
      return Promise.reject(new Error('WebSockets are not available in background context'));
    }
    
    addEventListener() {
      // No-op
    }
    
    removeEventListener() {
      // No-op
    }
  };
  
  debugLogger.info(DebugLogType.POLYFILLS, '[WEBSOCKET-POLYFILL] Using mock WebSocket implementation for background context');
}

// Export the WebSocket class and constructor
export const WebSocket = WebSocketPolyfill;
export default WebSocketPolyfill;

// For CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebSocketPolyfill;
  module.exports.WebSocket = WebSocketPolyfill;
  module.exports.default = WebSocketPolyfill;
}

debugLogger.info(DebugLogType.POLYFILLS, '[WEBSOCKET-POLYFILL] WebSocket polyfill initialized'); 