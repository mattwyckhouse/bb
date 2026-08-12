#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRelativePath = "plugins/bb-plugin-finite-state";
const recovery = "file an amendment; do not edit the frozen artifact locally.";
const extensions = new Set([".ts", ".tsx", ".css"]);

function fail(message) {
  throw new Error(`${message}\nRecovery: ${recovery}`);
}

function rootFromArguments(argv) {
  if (!argv.length) return path.resolve(scriptDirectory, "../../..");
  if (argv.length === 2 && argv[0] === "--root") return path.resolve(argv[1]);
  fail("Usage: node scripts/check-ui-rules.mjs [--root <repository-root>]");
}

async function laneFiles(root) {
  const laneRoot = path.join(root, pluginRelativePath, "lanes");
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(fullPath);
    }
  }
  await visit(laneRoot);
  return files;
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

function violationsFor(relativePath, source) {
  const clean = withoutComments(source);
  const violations = [];
  const isCss = relativePath.endsWith(".css");
  const arbitraryColor = /\b(?:bg|text|border|ring|outline|fill|stroke|decoration|shadow)-\[(?:#[0-9a-fA-F]{3,8}\b|(?:oklch|rgb|rgba|hsl|hsla|color)\()/u;
  const contextualHex = /\b(?:color|background(?:-color)?|border(?:-color)?|fill|stroke|outline(?:-color)?)\s*[:=]\s*["'`]?#(?:[0-9a-fA-F]{3,8})\b/u;
  if ((isCss && /#[0-9a-fA-F]{3,8}\b/u.test(clean)) || (!isCss && (contextualHex.test(clean) || arbitraryColor.test(clean)))) {
    violations.push("raw hex color");
  }
  if (/\boklch\s*\(/u.test(clean)) violations.push("oklch() color");
  if (arbitraryColor.test(clean)) violations.push("arbitrary Tailwind color");
  if (/\bfrom\s*["'](?:lucide-react|@lucide\/[^"']+)["']|\brequire\s*\(\s*["'](?:lucide-react|@lucide\/[^"']+)/u.test(clean)) {
    violations.push("Lucide import");
  }
  if (relativePath.endsWith(".tsx")) {
    const jsxText = />[^<{]*\p{Extended_Pictographic}[^<{]*</u;
    const textLiteral = /["'`][^"'`\n]*\p{Extended_Pictographic}[^"'`\n]*["'`]/u;
    if (jsxText.test(clean) || textLiteral.test(clean)) violations.push("emoji in JSX/text literal");
    if (/\bfrom\s*["'][^"']*(?:\/lib\/remote|@modelcontextprotocol\/sdk|better-sqlite3|node:fs|node:path)[^"']*["']/u.test(clean)) {
      violations.push("frontend import crosses the RPC boundary");
    }
    if (/\b(?:fetch|PlatformClient|AssuranceStudioClient|ForgeComputeClient)\b/u.test(clean)) {
      violations.push("frontend direct-API/compute access");
    }
  }
  if (/\bfs_sync_push\b|\bfs_[a-z_]*(?:approve|reject|attest|resolve[_-]?conflict|lifecycle)[a-z_]*\b/u.test(clean)) {
    violations.push("human-only mutation path");
  }
  if (/\bregisterTool\s*\(\s*\{[\s\S]{0,500}?name\s*:\s*["'](?:fs_verification_run|fs_bench_run|fs_firmware_materialize)["'][\s\S]{0,500}?(?:write|update|delete|push|mutate)/u.test(clean)) {
    // The three names are the only action-tool exception; this condition is deliberately informationally silent for them.
  } else if (/\bregisterTool\s*\(\s*\{[\s\S]{0,500}?(?:write|update|delete|push|mutate)[\s\S]{0,500}?\}/u.test(clean)) {
    violations.push("agent action tool is outside the three-name allowlist");
  }
  return violations;
}

async function main() {
  const root = rootFromArguments(process.argv.slice(2));
  const violations = [];
  for (const filePath of await laneFiles(root)) {
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    for (const violation of violationsFor(relativePath, await fs.readFile(filePath, "utf8"))) {
      violations.push(`${relativePath}: ${violation}`);
    }
  }
  if (violations.length) fail(`Finite State UI/safety rule violations:\n${violations.join("\n")}`);
  process.stdout.write("Finite State UI and lane safety rules are intact.\n");
}

export { violationsFor };

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
