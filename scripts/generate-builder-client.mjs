import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";

const selectedOperations = new Map([
  ["/verifications/sessions/{sessionId}/bootstrap", new Set(["get"])],
  ["/verifications/sessions/{sessionId}/claimant", new Set(["patch"])],
  ["/verifications/sessions/{sessionId}/events", new Set(["post"])],
  ["/verifications/sessions/{sessionId}/attestor-auth", new Set(["post"])],
  ["/verifications/sessions/{sessionId}/results", new Set(["post"])],
]);

const PRODUCTION_BUILDER_OPENAPI = "https://build.reclaimprotocol.org/openapi.yaml";

const { input: configuredInput, source: inputSource } = resolveBuilderOpenApiInput();
console.log(`Builder OpenAPI: ${configuredInput} (${inputSource})`);

const contract = await readContract(configuredInput);
const derived = selectBuilderOperations(contract);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "reclaim-builder-openapi-"));
const temporaryContract = join(temporaryDirectory, "openapi.json");
writeFileSync(temporaryContract, JSON.stringify(derived));

try {
  const env = { ...process.env, BUILDER_OPENAPI: temporaryContract };
  run("openapi-ts", [], env);
  run(
    "esbuild",
    [
      "src/generated/builder-bridge/index.ts",
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--target=es2022",
      "--outfile=src/generated/builder-bridge.gen.js",
    ],
    env,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function selectBuilderOperations(document) {
  const paths = {};
  const selectedSecuritySchemes = new Set();
  for (const [path, methods] of selectedOperations) {
    const sourcePath = document.paths?.[path];
    if (!sourcePath) throw new Error(`Builder contract is missing required path ${path}`);
    paths[path] = {};
    for (const method of methods) {
      if (!sourcePath[method])
        throw new Error(`Builder contract is missing ${method.toUpperCase()} ${path}`);
      paths[path][method] = sourcePath[method];
      for (const security of sourcePath[method].security || []) {
        for (const name of Object.keys(security)) selectedSecuritySchemes.add(name);
      }
    }
  }

  const references = new Set();
  for (const path of Object.values(paths)) collectReferences(path, references);
  const components = {};
  const pending = [...references];
  while (pending.length) {
    const reference = pending.pop();
    const match = /^#\/components\/([^/]+)\/(.+)$/.exec(reference);
    if (!match) continue;
    const [, kind, name] = match;
    const sourceComponent = document.components?.[kind]?.[name];
    if (!sourceComponent) throw new Error(`Builder contract is missing ${reference}`);
    components[kind] ||= {};
    if (components[kind][name]) continue;
    components[kind][name] = sourceComponent;
    const nested = new Set();
    collectReferences(sourceComponent, nested);
    for (const nestedReference of nested) {
      if (!references.has(nestedReference)) {
        references.add(nestedReference);
        pending.push(nestedReference);
      }
    }
  }
  for (const name of selectedSecuritySchemes) {
    const securityScheme = document.components?.securitySchemes?.[name];
    if (securityScheme) {
      components.securitySchemes ||= {};
      components.securitySchemes[name] = securityScheme;
    }
  }

  return {
    openapi: document.openapi,
    info: document.info,
    servers: document.servers,
    paths,
    components,
  };
}

function collectReferences(value, references) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string") references.add(value.$ref);
  for (const child of Object.values(value)) collectReferences(child, references);
}

function resolveBuilderOpenApiInput() {
  // BUILDER_OPENAPI is the documented variable. BRIDGE_OPENAPI stays as an
  // alias so an existing script that sets it keeps working. There is no
  // adjacent-checkout fallback: this repository sits alongside Builder under
  // devtools/, not project-new-tools/, so that path never matched a real
  // checkout and only misled anyone reading the resolution order.
  if (process.env.BUILDER_OPENAPI) {
    return { input: process.env.BUILDER_OPENAPI, source: "BUILDER_OPENAPI" };
  }
  if (process.env.BRIDGE_OPENAPI) {
    return { input: process.env.BRIDGE_OPENAPI, source: "BRIDGE_OPENAPI" };
  }
  return { input: PRODUCTION_BUILDER_OPENAPI, source: "production fallback" };
}

async function readContract(input) {
  const contents =
    input.startsWith("http://") || input.startsWith("https://")
      ? await (await fetch(input)).text()
      : readFileSync(input, "utf8");
  const parsed = load(contents);
  if (!parsed || typeof parsed !== "object")
    throw new Error("Builder OpenAPI contract is not an object");
  return parsed;
}

function run(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
}
