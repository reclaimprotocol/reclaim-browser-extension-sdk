import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

it("asset setup replaces stale downloaded and consumer Stwo WASM with the installed release", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reclaim-assets-test-"));
  const write = (file, contents) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  try {
    const installer = path.join(root, "build/scripts/install-assets.js");
    mkdirSync(path.dirname(installer), { recursive: true });
    copyFileSync(fileURLToPath(new URL("./install-assets.js", import.meta.url)), installer);
    const zk = "node_modules/@reclaimprotocol/zk-symmetric-crypto";
    write(`${zk}/package.json`, JSON.stringify({ main: "lib/index.js" }));
    write(`${zk}/lib/index.js`, "");
    write(`${zk}/lib/stwo/s2circuits_bg.wasm`, "patched-release-wasm");
    write(`${zk}/resources/stwo/s2circuits_bg.wasm`, "stale-downloaded-wasm");
    write(`${zk}/resources/stwo/s2circuits.js`, "browser-glue");
    for (const file of [
      "content/content.bundle.js",
      "interceptor/network-interceptor.bundle.js",
      "offscreen/offscreen.bundle.js",
      "ReclaimExtensionSDK.bundle.js",
    ])
      write(`build/${file}`, "bundle");

    const target = "public/browser-rpc/resources/stwo/s2circuits_bg.wasm";
    for (let run = 0; run < 2; run++) {
      write(target, "stale-consumer-wasm");
      const result = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(path.join(root, target), "utf8"), "patched-release-wasm");
      assert.equal(
        readFileSync(path.join(root, "public/browser-rpc/resources/stwo/s2circuits.js"), "utf8"),
        "browser-glue",
      );
    }

    // A missing release artifact must fail setup instead of shipping stale WASM.
    rmSync(path.join(root, zk, "lib/stwo/s2circuits_bg.wasm"));
    const missing = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /s2circuits_bg\.wasm/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
