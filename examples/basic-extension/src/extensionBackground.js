import { sdk } from "@reclaimprotocol/browser-extension-sdk";

console.log("Background script starting...");
try {
  sdk.runBackground();
  console.log("Background initialized");
} catch (error) {
  console.error("Background script error:", error);
}
