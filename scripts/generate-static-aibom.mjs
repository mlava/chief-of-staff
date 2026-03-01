import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  LLM_API_ENDPOINTS,
  DEFAULT_LLM_MODELS,
  POWER_LLM_MODELS,
  LUDICROUS_LLM_MODELS
} from "../src/aibom-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactsDir = path.join(rootDir, "artifacts");

function inferPackageNameFromPath(pkgPath) {
  if (!pkgPath.startsWith("node_modules/")) return "";
  const rel = pkgPath.slice("node_modules/".length);
  const parts = rel.split("/");
  if (parts[0]?.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] || "";
}

function toPurl(name, version) {
  if (!name || !version) return "";
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/");
    if (!scope || !pkg) return "";
    return `pkg:npm/${scope}/${pkg}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

function aiModelComponents() {
  const rows = [];
  const tiers = [
    ["mini", DEFAULT_LLM_MODELS],
    ["power", POWER_LLM_MODELS],
    ["ludicrous", LUDICROUS_LLM_MODELS]
  ];
  for (const [tier, models] of tiers) {
    for (const [provider, model] of Object.entries(models)) {
      rows.push({
        type: "machine-learning-model",
        name: `llm-model/${provider}/${tier}`,
        version: model,
        properties: [
          { name: "chief:aibom:component-class", value: "llm-model" },
          { name: "chief:aibom:provider", value: provider },
          { name: "chief:aibom:tier", value: tier }
        ]
      });
    }
  }
  return rows;
}

function providerEndpointComponents() {
  return Object.entries(LLM_API_ENDPOINTS).map(([provider, endpoint]) => ({
    type: "service",
    name: `llm-endpoint/${provider}`,
    version: "runtime-config",
    description: endpoint,
    endpoints: [endpoint],
    properties: [
      { name: "chief:aibom:component-class", value: "llm-endpoint" },
      { name: "chief:aibom:provider", value: provider }
    ]
  }));
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const packageLock = JSON.parse(await fs.readFile(path.join(rootDir, "package-lock.json"), "utf8"));
  const lockPackages = packageLock.packages || {};

  const npmComponents = [];
  for (const [pkgPath, meta] of Object.entries(lockPackages)) {
    if (!pkgPath || pkgPath === "") continue;
    const name = meta.name || inferPackageNameFromPath(pkgPath);
    const version = meta.version;
    if (!name || !version) continue;
    npmComponents.push({
      type: "library",
      name,
      version,
      purl: toPurl(name, version),
      properties: [
        { name: "chief:aibom:component-class", value: "npm-dependency" },
        { name: "chief:aibom:dev", value: meta.dev ? "true" : "false" }
      ]
    });
  }

  npmComponents.sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));

  const aiComponents = [...providerEndpointComponents(), ...aiModelComponents()];

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: "chief-of-staff",
          name: "generate-static-aibom",
          version: "1.0.0"
        }
      ],
      component: {
        type: "application",
        name: packageJson.name || "chief-of-staff",
        version: packageJson.version || "0.0.0"
      },
      properties: [
        { name: "chief:aibom:scope", value: "build-time-static" },
        { name: "chief:aibom:npm-component-count", value: String(npmComponents.length) },
        { name: "chief:aibom:ai-component-count", value: String(aiComponents.length) }
      ]
    },
    components: [...npmComponents, ...aiComponents],
    dependencies: []
  };

  const bomJson = JSON.stringify(bom, null, 2) + "\n";
  const sha256 = crypto.createHash("sha256").update(bomJson).digest("hex");
  const baseline = {
    generatedAt: bom.metadata.timestamp,
    serialNumber: bom.serialNumber,
    sha256,
    componentCount: bom.components.length,
    npmComponentCount: npmComponents.length,
    aiComponentCount: aiComponents.length
  };

  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, "aibom-static.cdx.json"), bomJson, "utf8");
  await fs.writeFile(path.join(artifactsDir, "aibom-static.baseline.json"), JSON.stringify(baseline, null, 2) + "\n", "utf8");

  console.log(`[AIBOM] Wrote artifacts/aibom-static.cdx.json (${bom.components.length} components)`);
  console.log(`[AIBOM] SHA-256: ${sha256}`);
}

main().catch((error) => {
  console.error("[AIBOM] Generation failed:", error?.message || error);
  process.exit(1);
});
