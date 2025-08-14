import { sdk } from "./reclaim-browser-extension-sdk/ReclaimExtensionSDK.bundle.js";

const $ = (id) => document.getElementById(id);

let request = null;

// Extra signals around start
console.log("[popup] SDK object", sdk);
console.log("[popup] Start button bound");

document.getElementById("startBtn").addEventListener("click", async () => {
  console.log("[popup] Start clicked");
  try {
    const appId = $("appId").value.trim();
    const appSecret = $("appSecret").value.trim();
    const providerId = $("providerId").value.trim();
    const callbackUrl = $("callbackUrl").value.trim();
    console.log({ appId, appSecret, providerId, callbackUrl });
    if (!appId || !appSecret || !providerId) return console.log("Fill appId, appSecret, providerId");

    request = await sdk.init(appId, appSecret, providerId, {
      extensionID: "coonladadmdfhgildikmdodffiejakkh",
    });
    console.log("[popup] request", request);
    if (callbackUrl) request.setAppCallbackUrl(callbackUrl);
    request.setParams({ demo: "1" });
    request.addContext("0x0", "popup demo");

    request.on("started", ({ sessionId }) => console.log("started", sessionId));
    request.on("completed", (proofs) => console.log("completed", proofs));
    request.on("error", (err) => console.log("error", err?.message || String(err)));

    const proofs = await request.startVerification();
    console.log("completed (promise)", proofs);
  } catch (e) {
    console.error(e);
    console.log("error", e?.message || String(e));
  }
});

document.getElementById("cancelBtn").addEventListener("click", async () => {
  try {
    if (request) await request.cancel();
    console.log("cancel requested");
  } catch (e) {
    console.log("cancel error", e?.message || String(e));
  }
});
