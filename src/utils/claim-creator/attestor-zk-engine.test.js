/**
 * Guard: the pinned attestor-core's prebuilt browser bundle must register a ZK
 * operator maker for the engine we default to.
 *
 * Why this exists. `browser/resources/attestor-browser.min.mjs` is a checked-in
 * build artifact upstream, produced by a separate `npm run build:browser` step
 * from the rest of the package. Its contents have changed *silently* between
 * patch releases:
 *
 *   version       ./browser ships   registers 'stwo'
 *   5.0.5         yes               yes
 *   5.0.6         yes               NO
 *   5.0.7         yes               NO
 *   5.0.8         yes               NO
 *   5.1.0-dev.1   yes               yes
 *   5.1.0         NO (404)          n/a
 *   5.1.1         yes               yes   <- current pin
 *
 * A bump into 5.0.6–5.0.8 produces no install error, no build error and no test
 * failure — it fails at runtime, deep in the offscreen document, as
 * "Proof generation failed: No ZK operator maker for stwo", after the user has
 * already logged into the provider. That is an expensive way to find out.
 *
 * So this asserts it statically against the shipped artifact. It is deliberately
 * a string check on the bundle rather than an attempt to instantiate the
 * operator: instantiating needs WASM, a circuit fetcher and the zk resources
 * copied into a consumer's public/ folder, none of which exist in a unit test.
 * The bundle either contains the engine's registration or it doesn't.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { DEFAULT_ZK_ENGINE } from "../constants/config.js";

const require = createRequire(import.meta.url);

// Resolve via the package's own entry, then walk up: the `exports` map blocks
// direct access to package.json (same trick install-assets.js uses).
const resolvePackageDir = (pkg) => {
  let dir = path.dirname(require.resolve(pkg));
  while (dir !== path.dirname(dir)) {
    try {
      readFileSync(path.join(dir, "package.json"));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error(`could not locate ${pkg}`);
};

describe("attestor browser bundle ZK engine support", () => {
  const pkgDir = resolvePackageDir("@reclaimprotocol/attestor-core");
  const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const bundlePath = path.join(pkgDir, "browser", "resources", "attestor-browser.min.mjs");

  it("ships the browser bundle offscreen.js imports", () => {
    // 5.1.0 dropped this file while still declaring exports['./browser'].
    assert.doesNotThrow(
      () => readFileSync(bundlePath),
      `attestor-core@${version} does not ship browser/resources/attestor-browser.min.mjs, ` +
        `which src/offscreen/offscreen.js imports as '@reclaimprotocol/attestor-core/browser'`,
    );
  });

  it(`registers a ZK operator maker for the default engine (${DEFAULT_ZK_ENGINE})`, () => {
    const bundle = readFileSync(bundlePath, "utf8");
    const hits = bundle.split(DEFAULT_ZK_ENGINE).length - 1;

    assert.ok(
      hits > 0,
      `attestor-core@${version}'s browser bundle contains no reference to ` +
        `'${DEFAULT_ZK_ENGINE}', so createClaimOnAttestor will throw ` +
        `"No ZK operator maker for ${DEFAULT_ZK_ENGINE}" at proof time. ` +
        `Pin a version whose browser bundle supports it (5.0.5 does).`,
    );
  });

  it("still contains the error we would otherwise hit at runtime", () => {
    // Sanity check on the detection method: if upstream ever renames this
    // error, the assertion above could pass for the wrong reason.
    const bundle = readFileSync(bundlePath, "utf8");
    assert.ok(
      bundle.includes("No ZK operator maker for"),
      "attestor-core's ZK operator lookup no longer throws the error this guard " +
        "was written against — re-check how engine support is detected.",
    );
  });
});
