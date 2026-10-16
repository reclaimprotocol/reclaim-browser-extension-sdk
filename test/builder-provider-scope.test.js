import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { builderRuntimeConfigForProvider } from "../src/utils/builder.js";

const config = {
  schemaVersion: 1,
  revision: 3,
  resolvedAt: "2026-09-20T00:00:00.000Z",
  values: { interceptionOptions: "PROXY", useStealth: false },
  providerValues: { "provider-b": { useStealth: true } },
  evaluations: {},
};

describe("builderRuntimeConfigForProvider", () => {
  it("applies the override for the provider being verified", () => {
    const scoped = builderRuntimeConfigForProvider(config, "provider-b");
    assert.equal(scoped.values.useStealth, true);
    // Flags that provider does not disagree about keep the session answer.
    assert.equal(scoped.values.interceptionOptions, "PROXY");
  });

  it("leaves another provider on the session-wide answer", () => {
    const scoped = builderRuntimeConfigForProvider(config, "provider-a");
    assert.equal(scoped.values.useStealth, false);
  });

  it("handles a session with nothing scoped, and no config at all", () => {
    assert.equal(builderRuntimeConfigForProvider(config, undefined), config);
    assert.equal(builderRuntimeConfigForProvider(null, "provider-b"), null);
    assert.equal(
      builderRuntimeConfigForProvider(
        { ...config, providerValues: undefined },
        "provider-b",
      ).values.useStealth,
      false,
    );
  });

  it("does not mutate the configuration it was given", () => {
    builderRuntimeConfigForProvider(config, "provider-b");
    assert.equal(config.values.useStealth, false);
  });
});
