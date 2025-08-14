// src/utils/shims/tls-browser.js
export function strToUint8Array(str) {
  return new TextEncoder().encode(str);
}
export function uint8ArrayToStr(u8) {
  return new TextDecoder().decode(u8);
}
export default { strToUint8Array, uint8ArrayToStr };
