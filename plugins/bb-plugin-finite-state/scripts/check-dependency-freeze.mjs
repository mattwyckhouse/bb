#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRelativePath = "plugins/bb-plugin-finite-state";
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const recovery = "file an amendment; do not edit the frozen artifact locally.";

function fail(message) {
  throw new Error(`${message}\nRecovery: ${recovery}`);
}

function rootFromArguments(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return path.resolve(scriptDirectory, "../../..");
  if (!argv[index + 1] || argv.length !== 2) fail("--root requires exactly one directory path");
  return path.resolve(argv[index + 1]);
}

function normalizedSections(manifest) {
  return Object.fromEntries(sections.map((section) => [
    section,
    Object.fromEntries(Object.entries(manifest[section] ?? {}).sort(([left], [right]) => left.localeCompare(right, "en"))),
  ]));
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot parse ${label}: ${error.message}`);
  }
}

async function main() {
  const root = rootFromArguments(process.argv.slice(2));
  const pluginRoot = path.join(root, pluginRelativePath);
  const baseline = await readJson(path.join(pluginRoot, "frozen-artifacts.json"), "frozen-artifacts.json");
  const manifest = await readJson(path.join(pluginRoot, "package.json"), "plugin package.json");
  const expected = baseline.dependencyBaseline;
  if (!expected || sections.some((section) => !expected[section])) {
    fail("frozen-artifacts.json does not contain a complete dependencyBaseline");
  }
  const actual = normalizedSections(manifest);
  const drift = sections.filter((section) => JSON.stringify(actual[section]) !== JSON.stringify(expected[section]));
  if (drift.length) {
    fail(`Plugin dependency freeze drift in ${drift.join(", ")}`);
  }
  const pluginZod = sections.find((section) => Object.hasOwn(actual[section], "zod"));
  if (pluginZod) {
    fail(`Plugin must not declare zod directly (found in ${pluginZod}); the repository override pins zod 4.3.6`);
  }
  const rootManifest = await readJson(path.join(root, "package.json"), "root package.json");
  if (rootManifest.pnpm?.overrides?.zod !== "4.3.6") {
    fail("Root zod override must remain pinned to 4.3.6");
  }
  process.stdout.write("Plugin dependency baseline is intact; zod is repository-pinned to 4.3.6.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
