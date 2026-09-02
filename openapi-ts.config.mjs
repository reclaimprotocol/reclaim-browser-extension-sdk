import { existsSync } from "node:fs";
import { resolve } from "node:path";

const adjacentContract = resolve("../project-new-tools/builder/packages/app/openapi.yaml");

/** @type {import('@hey-api/openapi-ts').UserConfig} */
export default {
  input:
    process.env.BUILDER_OPENAPI ||
    process.env.BRIDGE_OPENAPI ||
    (existsSync(adjacentContract)
      ? adjacentContract
      : "https://build.reclaimprotocol.org/openapi.yaml"),
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
