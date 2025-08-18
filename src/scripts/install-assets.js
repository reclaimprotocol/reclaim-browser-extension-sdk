#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const [k, v] = args[i].split("=");
    if (k.startsWith("--")) out[k.replace(/^--/, "")] = v ?? true;
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, entry);
    const d = path.join(destDir, entry);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

async function main() {
  const args = parseArgs();
  const projectRoot = process.cwd();

  const sdkBuild = path.resolve(__dirname, "..");

  const publicDir = path.resolve(projectRoot, args["public-dir"] || "public");

  // 1) Download circuits into public/browser-rpc/resources
  console.log("[reclaim] downloading circuits...");
  const dlScript = path.join(sdkBuild, "scripts", "download-circuits.js");
  try {
    cp.execFileSync(process.execPath, [dlScript], { stdio: "inherit", cwd: projectRoot });
  } catch (e) {
    console.error("[reclaim] circuits download failed", e.message);
    process.exit(1);
  }

  // 2) Copy SDK assets into public/reclaim-browser-extension-sdk
  console.log("[reclaim] copying assets...");
  const targetBase = path.join(publicDir, "reclaim-browser-extension-sdk");

  // content
  copyFile(
    path.join(sdkBuild, "content", "content.bundle.js"),
    path.join(targetBase, "content", "content.bundle.js"),
  );
  copyDir(
    path.join(sdkBuild, "content", "components"),
    path.join(targetBase, "content", "components"),
  );

  // interceptor
  copyDir(path.join(sdkBuild, "interceptor"), path.join(targetBase, "interceptor"));

  // offscreen
  copyDir(path.join(sdkBuild, "offscreen"), path.join(targetBase, "offscreen"));

  // optional bundle
  const b343 = path.join(sdkBuild, "343.bundle.js");
  if (fs.existsSync(b343)) copyFile(b343, path.join(publicDir, "343.bundle.js"));

  // 3) Copy SDK bundle into public/reclaim-browser-extension-sdk
  copyFile(
    path.join(sdkBuild, "ReclaimExtensionSDK.bundle.js"),
    path.join(publicDir, "reclaim-browser-extension-sdk", "ReclaimExtensionSDK.bundle.js"),
  );
  // optionally also MV2
  // copyFile(path.join(sdkBuild, "ReclaimExtensionSDK-mv2.bundle.js"), path.join(publicDir, "reclaim-browser-extension-sdk", "ReclaimExtensionSDK-mv2.bundle.js"));

  console.log("[reclaim] setup complete");
}

main().catch((e) => {
  console.error("[reclaim] setup failed", e);
  process.exit(1);
});
