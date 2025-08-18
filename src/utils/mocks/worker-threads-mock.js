/**
 * Simple mock for Node.js worker_threads module
 */

module.exports = {
  Worker: class MockWorker {
    constructor() {
      console.warn("Worker threads are not supported in browser environment");
      this.onmessage = null;
      this.onerror = null;
    }

    postMessage() {
      console.warn("postMessage called on mock Worker");
    }

    terminate() {
      console.warn("terminate called on mock Worker");
    }
  },

  isMainThread: true,
  parentPort: null,
  threadId: 0,
  workerData: {},

  // Other required exports
  MessageChannel: class MockMessageChannel {
    constructor() {
      this.port1 = {};
      this.port2 = {};
    }
  },

  // No-op functions
  markAsUntransferable: (obj) => obj,
  moveMessagePortToContext: () => null,
  receiveMessageOnPort: () => null,

  // Constants
  SHARE_ENV: Symbol("SHARE_ENV"),
};
