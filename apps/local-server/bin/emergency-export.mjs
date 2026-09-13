#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { createEmergencyBundle, verifyEmergencyBundle } from "../lib/emergency-export.mjs";

const args = process.argv.slice(2);
const verifyIndex = args.indexOf("--verify");

try {
  if (verifyIndex >= 0) {
    const bundle = args[verifyIndex + 1];
    if (!bundle) usage("--verify requires a bundle directory");
    const result = await verifyEmergencyBundle(resolve(bundle));
    process.stdout.write(`${JSON.stringify({ ok: true, bundle: resolve(bundle), createdAt: result.manifest.createdAt, version: result.manifest.nexusBackup?.version, revision: result.manifest.nexusBackup?.revision, files: result.manifest.files.length }, null, 2)}\n`);
    process.exit(0);
  }

  const output = args[0];
  if (!output || output.startsWith("-")) usage("an output directory is required");
  const agentConfigPath = process.env.NEXUS_BACKUP_AGENT_CONFIG?.trim() || "/agent-config/agent.json";
  const manifest = await createEmergencyBundle({
    configDir: process.env.NEXUS_BACKUP_CONFIG_DIR?.trim() || "/config",
    agentConfigDir: process.env.NEXUS_BACKUP_AGENT_CONFIG_DIR?.trim() || dirname(agentConfigPath),
    outputDir: resolve(output),
    version: process.env.NEXUS_BACKUP_VERSION?.trim() || "unknown",
    revision: process.env.NEXUS_BACKUP_REVISION?.trim() || "unknown",
  });
  process.stdout.write(`${JSON.stringify({ ok: true, bundle: resolve(output), createdAt: manifest.createdAt, version: manifest.nexusBackup.version, revision: manifest.nexusBackup.revision, files: manifest.files.length, containsSecrets: true }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Emergency export failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("Usage:\n  node apps/local-server/bin/emergency-export.mjs <output-directory>\n  node apps/local-server/bin/emergency-export.mjs --verify <bundle-directory>\n");
  process.exit(2);
}
