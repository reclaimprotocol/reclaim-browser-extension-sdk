import * as s2circuits from "/browser-rpc/resources/stwo/s2circuits.js";
window.s2circuits = s2circuits;

// Load offscreen bundle after s2circuits is on window
const script = document.createElement("script");
script.src = "./offscreen.bundle.js";
document.head.appendChild(script);
