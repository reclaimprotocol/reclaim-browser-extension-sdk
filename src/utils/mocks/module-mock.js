/**
 * Browser mock for Node.js 'module' built-in.
 * Provides a createRequire shim so that ESM wrappers
 * (e.g. zk-symmetric-crypto/s2circuits-wrapper.js) don't crash.
 */
module.exports = {
  createRequire: () => {
    return () => ({});
  },
};
