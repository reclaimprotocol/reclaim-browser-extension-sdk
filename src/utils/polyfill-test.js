// Test file to verify polyfill functionality
import "./polyfills";
import { createClaimOnAttestor } from "@reclaimprotocol/attestor-core";

export const testPolyfills = () => {
  console.log("[POLYFILLS] Testing polyfills for @reclaimprotocol/attestor-core");

  // Verify Buffer is available
  console.log("[POLYFILLS] Buffer available:", typeof Buffer !== "undefined");

  // Verify process is available
  console.log("[POLYFILLS] process available:", typeof process !== "undefined");

  // Verify createClaimOnAttestor is a function
  console.log(
    "[POLYFILLS] createClaimOnAttestor is a function:",
    typeof createClaimOnAttestor === "function",
  );

  // Test other polyfilled APIs
  console.log("[POLYFILLS] TextEncoder available:", typeof TextEncoder !== "undefined");
  console.log("[POLYFILLS] TextDecoder available:", typeof TextDecoder !== "undefined");
  console.log("[POLYFILLS] crypto available:", typeof crypto !== "undefined");
  console.log(
    "[POLYFILLS] crypto.getRandomValues available:",
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
