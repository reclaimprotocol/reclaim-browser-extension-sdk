// Test file to verify polyfill functionality
import "./polyfills";
import { createClaimOnAttestor } from "@reclaimprotocol/attestor-core";
import { debugLogger, DebugLogType } from "./logger";

export const testPolyfills = () => {
  debugLogger.info(DebugLogType.POLYFILLS, "Testing polyfills for @reclaimprotocol/attestor-core");

  // Verify Buffer is available
  debugLogger.info(DebugLogType.POLYFILLS, "Buffer available:", typeof Buffer !== "undefined");

  // Verify process is available
  debugLogger.info(DebugLogType.POLYFILLS, "process available:", typeof process !== "undefined");

  // Verify createClaimOnAttestor is a function
  debugLogger.info(
    DebugLogType.POLYFILLS,
    "createClaimOnAttestor is a function:",
    typeof createClaimOnAttestor === "function",
  );

  // Test other polyfilled APIs
  debugLogger.info(
    DebugLogType.POLYFILLS,
    "TextEncoder available:",
    typeof TextEncoder !== "undefined",
  );
  debugLogger.info(
    DebugLogType.POLYFILLS,
    "TextDecoder available:",
    typeof TextDecoder !== "undefined",
  );
  debugLogger.info(DebugLogType.POLYFILLS, "crypto available:", typeof crypto !== "undefined");
  debugLogger.info(
    DebugLogType.POLYFILLS,
    "crypto.getRandomValues available:",
    typeof crypto.getRandomValues !== "undefined",
  );

  return {
    buffer: typeof Buffer !== "undefined",
    process: typeof process !== "undefined",
    createClaimOnAttestor: typeof createClaimOnAttestor === "function",
    textEncoder: typeof TextEncoder !== "undefined",
    textDecoder: typeof TextDecoder !== "undefined",
    crypto: typeof crypto !== "undefined",
    getRandomValues: typeof crypto.getRandomValues !== "undefined",
  };
};
