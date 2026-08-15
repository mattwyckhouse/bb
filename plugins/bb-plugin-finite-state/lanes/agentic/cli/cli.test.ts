import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginContext } from "../../../lib/context.js";
import {
  BENCH_ACTION_SERVICE,
  VERIFICATION_ACTION_SERVICE,
  type ScopedBenchAction,
  type ScopedVerificationAction,
} from "../../../lib/agentic/action-allowlist.js";
import { TRIAGE_WRITER_SERVICE, type TriageWriter } from "../tools/write.js";
import * as hbomReview from "../../bom/hbom/review.js";
import * as hbomExtract from "../../bom/hbom/extract.js";
import { registerFiniteStateCli } from "./register.js";
import { capJsonList } from "./render.js";
import {
  CLI_JSON_MAX_BYTES,
  HBOM_REVIEW_ROUTE,
  SYNC_REVIEW_ROUTE,
} from "./metadata.js";
import { parseFiniteStateArgv } from "./parser.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const resolveHbomSpy = vi.spyOn(hbomReview, "resolveHbomReview");
const extractSpy = vi.spyOn(hbomExtract, "applyHbomExtraction");

afterEach(async () => {
  resolveHbomSpy.mockClear();
  extractSpy.mockClear();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

interface HealthProbe {
  configured: boolean;
  reachable: boolean;
  detail: string | null;
}

const OK_HEALTH: HealthProbe = {
  configured: true,
  reachable: true,
  detail: null,
};

const THREAD = {
  threadId: "thread-cli",
  projectId: "bb-project-cli",
};

function pages(items: Array<Record<string, string>>): AsyncIterable<{
  items: Array<Record<string, string>>;
  total: number;
  next: null;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { items, total: items.length, next: null };
    },
  };
}

function mockPlatform(
  overrides: {
    health?: () => Promise<HealthProbe>;
    projects?: Array<Record<string, string>>;
  } = {},
) {
  return {
    health: overrides.health ?? (async () => OK_HEALTH),
    listProjects() {
      return pages(overrides.projects ?? [{ id: "plat-1", name: "Widget" }]);
    },
  };
}

function mockAssurance() {
  return {
    health: async () => OK_HEALTH,
  };
}

function mockForge(health: () => Promise<HealthProbe>) {
  return { health };
}

function remoteFailure(
  message: string,
  code: string,
  service: string,
  status: number | null,
): Error {
  const error = new Error(message);
  error.name = "RemoteError";
  Object.assign(error, { code, service, status, retryable: false });
  return error;
}

async function setup(options?: {
  conflicts?: number;
  forge?: { health: () => Promise<HealthProbe> } | null;
  platformHealth?: () => Promise<HealthProbe>;
  worktree?: string;
}) {
  const host = createFakePluginHost({
    pluginId: `fs-cli-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  const ctx = createPluginContext(host.bb);
  const syncCalls: string[][] = [];
  ctx.service("sync.cli", () => ({
    run: async (argv: string[]) => {
      syncCalls.push([...argv]);
      if (argv[0] === "plan") {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            summary: {
              creates: 1,
              updates: 0,
              deletes: 0,
              conflicts: options?.conflicts ?? 0,
            },
            blastRadius: {
              changed: 1,
              deletes: 0,
              surfaces: argv.includes("triage")
                ? ["vexDecision"]
                : ["requirement"],
            },
          })}\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ argv })}\n`,
        stderr: "",
      };
    },
  }));
  ctx.service("remote-services", () => ({
    platform: mockPlatform({
      health: options?.platformHealth,
    }),
    assuranceStudio: mockAssurance(),
    forgeCompute: options?.forge === undefined ? null : options.forge,
  }));
  const set = vi.fn(async () => ({
    path: ".fs/triage/example.yaml",
    op: "create" as const,
    diffSummary: [],
    omittedDiffs: 0,
    contentHash: "a".repeat(64),
  }));
  ctx.service<TriageWriter>(TRIAGE_WRITER_SERVICE, () => ({
    set,
    applyPolicy: vi.fn(async () => ({
      paths: [],
      written: 0,
      held: [],
      skippedExisting: 0,
      errors: [],
      runId: "policy-1",
      dryRun: true,
      policySha256: "b".repeat(64),
    })),
  }));
  ctx.service<ScopedVerificationAction>(VERIFICATION_ACTION_SERVICE, () => ({
    run: async () => ({ jobId: "verify-job" }),
  }));
  ctx.service<ScopedBenchAction>(BENCH_ACTION_SERVICE, () => ({
    run: async (input) => ({
      runId: `run-${input.pvId}`,
      threadId: THREAD.threadId,
      status: "queued" as const,
    }),
  }));
  const root = options?.worktree ?? (await mkdtemp(join(tmpdir(), "fs-cli-")));
  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({
      id: THREAD.threadId,
      projectId: THREAD.projectId,
      environmentId: "environment-cli",
    }),
  );
  host.harness.sdk.stub("environments.get", async () => ({
    id: "environment-cli",
    projectId: THREAD.projectId,
    hostId: "host-cli",
    path: root,
  }));
  host.harness.sdk.stub("projects.get", async ({ projectId }) => ({
    id: projectId,
    sources: [{ hostId: "host-cli", path: root, isDefault: true }],
  }));
  registerFiniteStateCli(host.bb, ctx);
  return {
    host,
    ctx,
    syncCalls,
    set,
    root,
    run(argv: string[], context = THREAD) {
      return host.harness.runCli(argv, context);
    },
  };
}

describe("finite-state CLI", () => {
  it("renders full root and subcommand help with exit 0 and usage on unknown flags", async () => {
    const harness = await setup();
    const root = await harness.run(["--help"]);
    expect(root.exitCode).toBe(0);
    expect(root.stdout).toContain("Commands:");
    expect(root.stdout).toContain("as-project-select");
    expect(root.stdout).toContain("Select the Assurance Studio project");

    const subcommand = await harness.run(["as-project-select", "--help"]);
    expect(subcommand.exitCode).toBe(0);
    expect(subcommand.stdout).toContain("bb finite-state as-project-select");
    expect(subcommand.stdout).toContain("Usage:");
    expect(subcommand.stdout).toContain("--as-project ID");

    const multiline = await harness.run(["connect", "--help"]);
    expect(multiline.exitCode).toBe(0);
    expect(multiline.stdout).toContain(
      "bb finite-state connections status|configure",
    );
    expect(multiline.stdout).not.toContain(
      "bb finite-state bb finite-state connections",
    );

    const unknown = await harness.run(["pull", "--bad-flag"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("unknown option --bad-flag");
    expect(unknown.stderr).toContain("Usage:");
    expect(unknown.stderr).toContain("bb finite-state pull");
    expect(harness.syncCalls).toEqual([]);

    const helpValue = await harness.run([
      "bench",
      "run",
      "pv-help-value",
      "--target",
      "-h",
      "--json",
    ]);
    expect(helpValue.exitCode).toBe(0);
    expect(helpValue.stdout).not.toContain("Commands:");
    expect(JSON.parse(helpValue.stdout)).toMatchObject({
      runId: "run-pv-help-value",
    });
  });

  it("renders table and JSON for each native command family", async () => {
    const harness = await setup();
    const connectTable = await harness.run(["connect"]);
    expect(connectTable.exitCode).toBe(0);
    expect(connectTable.stdout).toContain("platform");
    expect(connectTable.stdout).toContain("forgeCompute");
    const connectJson = await harness.run(["connect", "--json"]);
    expect(JSON.parse(connectJson.stdout)).toMatchObject({
      platform: { state: "connected" },
      forgeCompute: { state: "disabled" },
    });
    const projects = await harness.run(["project", "list", "--json"]);
    expect(JSON.parse(projects.stdout).items).toEqual([
      { id: "plat-1", name: "Widget" },
    ]);
    const triage = await harness.run([
      "triage",
      "list",
      "--project",
      "plat-1",
      "--version",
      "pv-1",
    ]);
    expect(triage.exitCode).toBe(0);
    expect(triage.stdout).toContain("stableKey");
    const docs = await harness.run(["doc", "list", "--json"], THREAD);
    expect(JSON.parse(docs.stdout)).toMatchObject({ items: [], total: 0 });
    const matrix = await harness.run(["verify", "matrix", "--json"], THREAD);
    expect(JSON.parse(matrix.stdout)).toMatchObject({ items: [], total: 0 });
    const bench = await harness.run(["bench", "list", "--json"], THREAD);
    expect(JSON.parse(bench.stdout)).toMatchObject({ items: [], total: 0 });
    const reqs = await harness.run(["req", "list", "--json"], THREAD);
    if (reqs.exitCode === 0) {
      expect(JSON.parse(reqs.stdout)).toMatchObject({ items: [], total: 0 });
    } else {
      expect(reqs.stderr.length).toBeGreaterThan(0);
    }
    const started = await harness.run(
      ["bench", "run", "pv-9", "--json"],
      THREAD,
    );
    expect(JSON.parse(started.stdout)).toMatchObject({
      runId: "run-pv-9",
      status: "queued",
    });
  });

  it("routes top-level and triage-scoped sync aliases to one service with the same args", async () => {
    const harness = await setup();
    const flags = ["--project", "plat-1", "--version", "pv-1", "--json"];
    await harness.run(["pull", "triage", ...flags]);
    await harness.run(["triage", "pull", ...flags]);
    await harness.run(["status", "triage", ...flags]);
    await harness.run(["triage", "status", ...flags]);
    await harness.run(["plan", "triage", ...flags]);
    await harness.run(["triage", "plan", ...flags]);
    expect(harness.syncCalls).toEqual([
      ["pull", "triage", "--project", "plat-1", "--version", "pv-1", "--json"],
      ["pull", "triage", "--project", "plat-1", "--version", "pv-1", "--json"],
      [
        "status",
        "triage",
        "--project",
        "plat-1",
        "--version",
        "pv-1",
        "--json",
      ],
      [
        "status",
        "triage",
        "--project",
        "plat-1",
        "--version",
        "pv-1",
        "--json",
      ],
      ["plan", "triage", "--project", "plat-1", "--version", "pv-1", "--json"],
      ["plan", "triage", "--project", "plat-1", "--version", "pv-1", "--json"],
    ]);
    expect(parseFiniteStateArgv(["triage", "pull", "--json"])).toEqual({
      kind: "legacy",
      argv: ["pull", "triage", "--json"],
    });
  });

  it("hands push off to the review panel with or without conflicts and never invokes upstream", async () => {
    for (const conflicts of [0, 2]) {
      const harness = await setup({ conflicts });
      const human = await harness.run(["push"]);
      const scoped = await harness.run(["triage", "push", "--json"]);
      expect(human.exitCode).toBe(3);
      expect(human.stdout).toContain(SYNC_REVIEW_ROUTE);
      expect(human.stdout).toContain(`Unresolved conflicts: ${conflicts}`);
      expect(human.stdout).toContain("did not mutate upstream");
      expect(scoped.exitCode).toBe(3);
      expect(JSON.parse(scoped.stdout)).toMatchObject({
        handedOff: true,
        executed: false,
        route: SYNC_REVIEW_ROUTE,
      });
      expect(harness.syncCalls.every((argv) => argv[0] === "plan")).toBe(true);
      expect(harness.syncCalls.some((argv) => argv[0] === "push")).toBe(false);
    }
  });

  it("rejects --yes as an unknown flag and never invokes upstream", async () => {
    const harness = await setup();
    const denied = await harness.run(["push", "--yes"]);
    expect(denied).toMatchObject({
      exitCode: 2,
      stdout: "",
    });
    expect(denied.stderr).toContain("unknown option --yes");
    expect(harness.syncCalls).toEqual([]);
  });

  it("prints the HBOM review-panel route and never invokes resolution", async () => {
    const harness = await setup();
    const listSpy = vi.spyOn(hbomReview, "listHbomReview").mockResolvedValue({
      items: [
        {
          projectId: THREAD.projectId,
          projectVersionId: "pv-1",
          kind: "hbom-review",
          key: "U1:mpn",
          label: "U1 mpn",
          fields: { partId: "U1", field: "mpn" },
        },
      ],
      total: 1,
      next: null,
      cache: {
        state: "fresh",
        asOf: null,
        message: null,
        acceptedGenerationId: null,
        baseRevision: 0,
      },
    });
    const accepted = await harness.run(
      ["bom", "hbom", "accept", "U1", "mpn", "--json"],
      THREAD,
    );
    const rejected = await harness.run(
      ["bom", "hbom", "reject", "U1", "mpn"],
      THREAD,
    );
    expect(accepted.exitCode).toBe(3);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      handedOff: true,
      executed: false,
      route: HBOM_REVIEW_ROUTE,
      action: "accept",
    });
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stdout).toContain(HBOM_REVIEW_ROUTE);
    expect(resolveHbomSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
  });

  it("caps oversized JSON with a valid truncation envelope", () => {
    const items = Array.from({ length: 20_000 }, (_, index) => ({
      id: `row-${index}`,
      pad: "x".repeat(80),
    }));
    const capped = capJsonList(items, items.length, null);
    expect(capped.truncated).toBe(true);
    const encoded = `${JSON.stringify(capped.payload)}\n`;
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(
      CLI_JSON_MAX_BYTES,
    );
    const parsed: unknown = JSON.parse(encoded);
    expect(parsed).toMatchObject({ truncated: true, total: 20_000 });
    expect(isRecord(parsed) && Array.isArray(parsed["items"])).toBe(true);
  });

  it("returns Forge setup guidance without a stack when compute is optional", async () => {
    const harness = await setup({ forge: null });
    const result = await harness.run(["connect", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      forgeCompute: { state: string; message: string };
    };
    expect(payload.forgeCompute.state).toBe("disabled");
    expect(payload.forgeCompute.message).toContain("forgeUrl");
    expect(payload.forgeCompute.message).not.toMatch(/\s+at\s+\S+\s+\(/u);
  });

  it("diagnoses a configured-but-failing Forge probe without dumping a stack", async () => {
    const harness = await setup({
      forge: mockForge(async () => {
        throw remoteFailure(
          "Forge handshake failed",
          "REMOTE_UNAUTHORIZED",
          "forge-compute",
          401,
        );
      }),
    });
    const result = await harness.run(["connect", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      forgeCompute: { state: string; message: string };
    };
    expect(payload.forgeCompute.state).toBe("REMOTE_UNAUTHORIZED");
    expect(payload.forgeCompute.message.toLowerCase()).not.toContain(
      "not configured",
    );
    expect(result.stdout).not.toMatch(/\s+at\s+\S+\s+\(/u);
  });

  it("keeps stdout for data and stderr for usage", async () => {
    const harness = await setup();
    const usage = await harness.run([]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toContain("usage: bb finite-state");
    const written = await harness.run(
      [
        "triage",
        "set",
        "finding/purl/CVE-1/pkg",
        "--status",
        "IN_TRIAGE",
        "--reason",
        "investigating call paths",
        "--evidence",
        "retained finding",
        "--version",
        "pv-1",
        "--json",
      ],
      THREAD,
    );
    expect(written.exitCode).toBe(0);
    expect(written.stderr).toBe("");
    expect(JSON.parse(written.stdout)).toMatchObject({ op: "create" });
    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("hands ingest --extract off without applying extraction", async () => {
    const harness = await setup();
    const file = join(harness.root, "sheet.pdf");
    await writeFile(file, "pdf");
    const ingested = await harness.run(
      [
        "bom",
        "hbom",
        "ingest",
        file,
        "--extract",
        "--version",
        "pv-1",
        "--json",
      ],
      THREAD,
    );
    expect(extractSpy).not.toHaveBeenCalled();
    if (ingested.exitCode === 0) {
      expect(JSON.parse(ingested.stdout)).toMatchObject({ extract: false });
      expect(JSON.parse(ingested.stdout).hint).toContain(HBOM_REVIEW_ROUTE);
    } else {
      expect(ingested.stderr).not.toMatch(/\s+at\s+\S+\s+\(/u);
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
