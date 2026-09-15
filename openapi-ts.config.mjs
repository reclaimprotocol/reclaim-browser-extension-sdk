const PRODUCTION_BUILDER_OPENAPI = "https://build.reclaimprotocol.org/openapi.yaml";

/** @type {import('@hey-api/openapi-ts').UserConfig} */
export default {
  // BUILDER_OPENAPI is the documented variable; BRIDGE_OPENAPI stays as an
  // alias for compatibility. There is no adjacent-checkout fallback: this
  // repository sits alongside Builder under devtools/, not project-new-tools/,
  // so that path never matched a real checkout.
  input: process.env.BUILDER_OPENAPI || process.env.BRIDGE_OPENAPI || PRODUCTION_BUILDER_OPENAPI,
  output: {
    path: "src/generated/builder-bridge",
    format: "prettier",
  },
  plugins: [
    {
      name: "@hey-api/client-fetch",
      bundle: false,
      exportFromIndex: true,
    },
    {
      name: "@hey-api/typescript",
      enums: "javascript",
    },
    "@hey-api/sdk",
  ],
};
