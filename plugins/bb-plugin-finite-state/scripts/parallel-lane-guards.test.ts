import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const pluginRelativePath = "plugins/bb-plugin-finite-state";
const pluginRootRelativePath = `${pluginRelativePath}/`;
const frozenScript = path.join(scriptDirectory, "check-frozen-artifacts.mjs");
const dependencyScript = path.join(scriptDirectory, "check-dependency-freeze.mjs");
const uiScript = path.join(scriptDirectory, "check-ui-rules.mjs");
const temporaryRoots: string[] = [];

const artifactPaths = [
  `${pluginRootRelativePath}server.ts`,
  `${pluginRootRelativePath}app.tsx`,
  `${pluginRootRelativePath}shared/contract.ts`,
  `${pluginRootRelativePath}lib/store/schema.ts`,
  `${pluginRootRelativePath}lib/sync/registry.ts`,
  `${pluginRootRelativePath}lib/remote/types.ts`,
  `${pluginRootRelativePath}test/mock-remote/fixtures/**`,
];

function run(script: string, root: string, ...arguments_: string[]) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [script, "--root", root, ...arguments_], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error: unknown) {
    let status = 1;
    let output = "";
    if (error && typeof error === "object") {
      if ("status" in error && typeof error.status === "number") status = error.status;
      if ("stdout" in error) output += processOutput(error.stdout);
      if ("stderr" in error) output += processOutput(error.stderr);
    }
    return {
      status,
      output,
    };
  }
}

function processOutput(value: unknown) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return "";
}

async function write(root: string, relativePath: string, contents: string) {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

function amendment(id: string, artifacts: string[], contractVersion = "n/a", status = "approved") {
  return `### ${id} — fixture amendment\n\n- Status: ${status}\n- Artifacts:\n${artifacts.map((artifact) => `  - \`${artifact}\``).join("\n")}\n- Contract version: ${contractVersion}\n`;
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "fs-guard-"));
  temporaryRoots.push(root);
  await write(root, "package.json", JSON.stringify({ pnpm: { overrides: { zod: "4.3.6" } } }));
  await write(root, `${pluginRootRelativePath}server.ts`, "export default function plugin() {}\n");
  await write(root, `${pluginRootRelativePath}app.tsx`, "export default function App() { return <div />; }\n");
  await write(root, `${pluginRootRelativePath}shared/contract.ts`, "export const CONTRACT_VERSION = 0 as const;\n");
  await write(root, `${pluginRootRelativePath}lib/store/schema.ts`, "export const MIGRATIONS: string[] = [];\n");
  await write(root, `${pluginRootRelativePath}lib/sync/registry.ts`, "export {};\n");
  await write(root, `${pluginRootRelativePath}lib/remote/types.ts`, "export {};\n");
  await write(root, `${pluginRootRelativePath}test/mock-remote/fixtures/base.json`, '{"fixture":true}\n');
  await write(root, `${pluginRootRelativePath}package.json`, JSON.stringify({ name: "bb-plugin-finite-state", dependencies: { yaml: "^2.9.0" } }));
  await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, amendment("A-000", [...artifactPaths, `${pluginRootRelativePath}package.json`], "0"));
  await write(root, `${pluginRootRelativePath}lanes/findings/register.app.tsx`, 'export const panel = <div className="bg-card text-muted-foreground">CVE-2025-1234 #CVE deadbeef</div>;\n');
  expect(run(frozenScript, root, "--accept", "A-000").status).toBe(0);
  const baselinePath = path.join(root, `${pluginRootRelativePath}frozen-artifacts.json`);
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  for (const artifact of Object.values(baseline.artifacts)) artifact.active = true;
  await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parallel lane guards", () => {
  it("accepts a clean baseline", async () => {
    const root = await fixtureRoot();
    expect(run(frozenScript, root).status).toBe(0);
    expect(run(dependencyScript, root).status).toBe(0);
    expect(run(uiScript, root).status).toBe(0);
  });

  it("captures diagnostics from a failed guard process", async () => {
    const root = await fixtureRoot();
    const result = run(frozenScript, root, "--accept", "AMD-0001");
    expect(result.status).toBe(1);
    expect(result.output).toContain("Amendment AMD-0001 is not a structured approved entry");
    expect(result.output).toContain("file an amendment; do not edit the frozen artifact locally.");
  });

  it("fails separately for root, frozen, and fixture-tree mutations", async () => {
    const root = await fixtureRoot();
    await write(root, `${pluginRootRelativePath}server.ts`, "export default function altered() {}\n");
    const rootMutation = run(frozenScript, root);
    expect(rootMutation.status).toBe(1);
    expect(rootMutation.output).toContain(`${pluginRootRelativePath}server.ts`);
    expect(rootMutation.output).toContain("file an amendment; do not edit the frozen artifact locally.");

    await write(root, `${pluginRootRelativePath}server.ts`, "export default function plugin() {}\n");
    await write(root, `${pluginRootRelativePath}lib/store/schema.ts`, "export const MIGRATIONS = [\"changed\"];\n");
    const frozenMutation = run(frozenScript, root);
    expect(frozenMutation.status).toBe(1);
    expect(frozenMutation.output).toContain(`${pluginRootRelativePath}lib/store/schema.ts`);

    await write(root, `${pluginRootRelativePath}lib/store/schema.ts`, "export const MIGRATIONS: string[] = [];\n");
    await write(root, `${pluginRootRelativePath}test/mock-remote/fixtures/extra.json`, "{}\n");
    const fixtureMutation = run(frozenScript, root);
    expect(fixtureMutation.status).toBe(1);
    expect(fixtureMutation.output).toContain(`${pluginRootRelativePath}test/mock-remote/fixtures/**`);
  });

  it("rejects prose-only, malformed, and unapproved amendment acceptance", async () => {
    const root = await fixtureRoot();
    await write(root, `${pluginRootRelativePath}app.tsx`, "export default function Changed() { return <main />; }\n");
    await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, "A prose note says this is fine.\n");
    const prose = run(frozenScript, root, "--accept", "AMD-0001");
    expect(prose.status).toBe(1);
    expect(prose.output).toContain("structured approved entry");

    await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, amendment("AMD-0001", [`${pluginRootRelativePath}app.tsx`], "n/a", "pending"));
    const pending = run(frozenScript, root, "--accept", "AMD-0001");
    expect(pending.status).toBe(1);
    expect(pending.output).toContain("structured approved entry");
  });

  it("updates only the approved changed artifact", async () => {
    const root = await fixtureRoot();
    await write(root, `${pluginRootRelativePath}app.tsx`, "export default function Changed() { return <main />; }\n");
    await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, amendment("AMD-0001", [`${pluginRootRelativePath}app.tsx`]));
    expect(run(frozenScript, root, "--accept", "AMD-0001").status).toBe(0);
    const baseline = JSON.parse(await readFile(path.join(root, `${pluginRootRelativePath}frozen-artifacts.json`), "utf8"));
    expect(baseline.artifacts[`${pluginRootRelativePath}app.tsx`].amendment).toBe("AMD-0001");
    expect(baseline.artifacts[`${pluginRootRelativePath}server.ts`].amendment).toBeNull();
  });

  it("requires an advancing CONTRACT_VERSION for contract amendments", async () => {
    const root = await fixtureRoot();
    await write(root, `${pluginRootRelativePath}shared/contract.ts`, "export const CONTRACT_VERSION = 1 as const;\n");
    await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, amendment("AMD-0002", [`${pluginRootRelativePath}shared/contract.ts`], "1"));
    expect(run(frozenScript, root, "--accept", "AMD-0002").status).toBe(0);
    await write(root, `${pluginRootRelativePath}shared/contract.ts`, "export const CONTRACT_VERSION = 1 as const; export type Extra = string;\n");
    await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, amendment("AMD-0003", [`${pluginRootRelativePath}shared/contract.ts`], "1"));
    expect(run(frozenScript, root, "--accept", "AMD-0003").output).toContain("CONTRACT_VERSION must advance");
  });

  it("does not freeze an unresolved interface before its approved activation", async () => {
    const root = await fixtureRoot();
    const baselinePath = path.join(root, `${pluginRootRelativePath}frozen-artifacts.json`);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.artifacts[`${pluginRootRelativePath}lib/remote/types.ts`].active = false;
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
    await write(root, `${pluginRootRelativePath}lib/remote/types.ts`, "export type Remote = { id: string };\n");
    expect(run(frozenScript, root).status).toBe(0);
    await write(root, `${pluginRootRelativePath}AMENDMENTS.md`, amendment("AMD-0004", [`${pluginRootRelativePath}lib/remote/types.ts`]));
    expect(run(frozenScript, root, "--accept", "AMD-0004").status).toBe(0);
    await write(root, `${pluginRootRelativePath}lib/remote/types.ts`, "export type Remote = { id: number };\n");
    expect(run(frozenScript, root).output).toContain(`${pluginRootRelativePath}lib/remote/types.ts`);
  });

  it.each([
    ["hex", '<div style={{ color: "#AABBCC" }} />', "raw hex color"],
    ["oklch", 'const color = "oklch(60% 0.2 30)"; export const panel = <div />;', "oklch() color"],
    ["arbitrary Tailwind", 'export const panel = <div className="bg-[#112233]" />;', "arbitrary Tailwind color"],
    ["Lucide", 'import { Bell } from "lucide-react"; export const panel = <Bell />;', "Lucide import"],
    ["emoji", 'const label = "✅"; export const panel = <div>{label}</div>;', "emoji in JSX/text literal"],
    ["frontend remote import", 'import { PlatformClient } from "../../lib/remote/client"; export const panel = <div />;', "frontend import crosses the RPC boundary"],
    ["direct API access", 'export const panel = <div>{fetch("/api")}</div>;', "frontend direct-API/compute access"],
    ["human mutation", 'export const name = "fs_sync_push";', "human-only mutation path"],
    ["unapproved action tool", 'bb.agents.registerTool({ name: "fs_other_run", description: "update a remote record" });', "agent action tool is outside the three-name allowlist"],
  ])("rejects %s", async (_name, source, expected) => {
    const root = await fixtureRoot();
    await write(root, `${pluginRootRelativePath}lanes/findings/register.app.tsx`, source);
    const result = run(uiScript, root);
    expect(result.status).toBe(1);
    expect(result.output).toContain(expected);
  });

  it("rejects dependency additions, versions, and direct zod", async () => {
    const root = await fixtureRoot();
    const manifestPath = `${pluginRootRelativePath}package.json`;
    await write(root, manifestPath, JSON.stringify({ name: "bb-plugin-finite-state", dependencies: { yaml: "^2.9.0", added: "1.0.0" } }));
    expect(run(dependencyScript, root).output).toContain("dependency freeze drift");
    await write(root, manifestPath, JSON.stringify({ name: "bb-plugin-finite-state", dependencies: { yaml: "^3.0.0" } }));
    expect(run(dependencyScript, root).output).toContain("dependency freeze drift");
    await write(root, manifestPath, JSON.stringify({ name: "bb-plugin-finite-state", dependencies: { yaml: "^2.9.0", zod: "4.3.6" } }));
    expect(run(dependencyScript, root).output).toContain("dependency freeze drift");
    const baselinePath = path.join(root, `${pluginRootRelativePath}frozen-artifacts.json`);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.dependencyBaseline.dependencies.zod = "4.3.6";
    await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
    expect(run(dependencyScript, root).output).toContain("must not declare zod directly");
  });

  it("keeps the exact guard command sequence in the verified CI workflow", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("pnpm exec turbo run typecheck test lint build --filter=bb-plugin-finite-state");
    expect(workflow).toContain("node plugins/bb-plugin-finite-state/scripts/check-frozen-artifacts.mjs");
    expect(workflow).toContain("node plugins/bb-plugin-finite-state/scripts/check-ui-rules.mjs");
    expect(workflow).toContain("node plugins/bb-plugin-finite-state/scripts/check-dependency-freeze.mjs");
  });
});
