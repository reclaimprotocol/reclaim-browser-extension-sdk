import { existsSync } from "node:fs";
import { resolve } from "node:path";

const adjacentContract = resolve(
  "../devtools/reclaim-sdk-backend/backend/openapi/builder-bridge.openapi.yaml",
);

/** @type {import('@hey-api/openapi-ts').UserConfig} */
export default {
  input:
    process.env.BRIDGE_OPENAPI ||
    (existsSync(adjacentContract)
      ? adjacentContract
      : "https://api.reclaimprotocol.org/api/sdk/builder/v2/openapi.yaml"),
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
