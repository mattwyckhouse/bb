import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../../lib/context.js";
import { KnownToolError } from "../../../lib/agentic/result.js";
import { HBOM_EMPTY_SHA256 } from "../../bom/hbom/yaml.js";
import { rebuildOverlayIndex } from "../../findings/overlay/indexer.js";
import { setDecision } from "../../findings/overlay/writer.js";
import { stableKeyFor } from "../../findings/overlay/schema.js";
import {
  HBOM_EXTRACTOR_SERVICE,
  TRIAGE_WRITER_SERVICE,
  registerWriteTools,
  type HbomExtractor,
  type TriageWriter,
} from "./write.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];
const toolsDir = dirname(fileURLToPath(import.meta.url));

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function parseTool(result: unknown): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; retryable?: boolean };
} {
  if (typeof result === "string") return JSON.parse(result);
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("unexpected tool result shape");
  }
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) throw new Error("missing tool content");
  const first = content[0];
  const text =
    typeof first === "object" &&
    first !== null &&
    typeof Reflect.get(first, "text") === "string"
      ? Reflect.get(first, "text")
      : null;
  if (typeof text !== "string") throw new Error("missing tool JSON");
  return JSON.parse(text);
}

async function seedFindings(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
  opts: {
    workspaceProjectId: string;
    platformProjectId: string;
    projectVersionId: string;
    stableKey: string;
  },
): Promise<void> {
  const at = "2026-08-15T00:00:00.000Z";
  db.prepare(
    `INSERT INTO workspace_platform_project_binding
      (workspace_project_id, platform_project_id)
     VALUES (?, ?)`,
  ).run(opts.workspaceProjectId, opts.platformProjectId);
  db.prepare(
    `INSERT INTO pull_generation
      (project_id, project_version_id, generation_id, status, requested_kinds_json, started_at, completed_at, accepted_at, error)
     VALUES (?, ?, 'generation-1', 'accepted', '["finding"]', ?, ?, ?, NULL)`,
  ).run(opts.platformProjectId, opts.projectVersionId, at, at, at);
  db.prepare(
    `INSERT INTO sync_state
      (project_id, project_version_id, entity_kind, accepted_generation_id, staging_generation_id, base_revision, staging_continuation, staged_pages, staged_rows, last_pull, error)
     VALUES (?, ?, 'finding', 'generation-1', NULL, 1, NULL, 0, 0, ?, NULL)`,
  ).run(opts.platformProjectId, opts.projectVersionId, at);
  db.prepare(
    `INSERT INTO findings
      (project_id, project_version_id, generation_id, finding_id, stable_key, cve,
       component_name, component_group, component_version, component_purl,
       reachability_factors, raw, pulled_at)
     VALUES (?, ?, 'generation-1', 'finding-1', ?, 'CVE-2026-100',
             'busybox', NULL, '1.36.1', 'pkg:generic/busybox@1.36.1',
             '[]', '{}', ?)`,
  ).run(opts.platformProjectId, opts.projectVersionId, opts.stableKey, at);
}

describe("write tool integration", () => {
  it("callAgentTool writes YAML, updates watcher index, and status reports local change", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fs-write-int-")));
    roots.push(root);
    const workspaceProjectId = "workspace-1";
    const platformProjectId = "platform-1";
    const projectVersionId = "version-1";
    const component = {
      purl: "pkg:generic/busybox@1.36.1",
      name: "busybox",
      group: null,
      version: "1.36.1",
    };
    const stableKey = stableKeyFor(
      platformProjectId,
      component,
      "CVE-2026-100",
    );
    const host = createFakePluginHost({
      pluginId: `fs-write-int-${crypto.randomUUID()}`,
      sdk: {
        projects: {
          get: ({ projectId }: { projectId: string }) => ({
            id: projectId,
            sources: [{ hostId: "host-1", path: root, isDefault: true }],
          }),
        },
      },
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    await seedFindings(ctx.db(), {
      workspaceProjectId,
      platformProjectId,
      projectVersionId,
      stableKey,
    });
    registerWriteTools(host.bb, ctx);

    const result = parseTool(
      await host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId,
          stableKey,
          status: "IN_TRIAGE",
          justification: null,
          response: null,
          reason: "investigating call paths carefully",
          evidence: "scanner finding and call graph retained",
        },
        { projectId: workspaceProjectId },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      op: "create",
      path: expect.stringMatching(/^\.fs\/triage\//),
    });
    const path = String(result.data?.path);
    const written = await readFile(join(root, path), "utf8");
    expect(written).toContain("CVE-2026-100:");
    expect(written).toContain("IN_TRIAGE");
    expect(written).not.toMatch(/finding-1|uuid/i);

    const index = await rebuildOverlayIndex(ctx.db(), root);
    expect(index.indexed).toBeGreaterThan(0);
    expect(
      host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "findings:changed",
      ),
    ).toBe(true);
  });

  it("two writers with same expected hash yield one success and one cas_mismatch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fs-write-cas-")));
    roots.push(root);
    const component = {
      purl: "pkg:generic/busybox@1.36.1",
      name: "busybox",
      group: null,
      version: "1.36.1",
    };
    const first = await setDecision(root, {
      project: "platform-1",
      component,
      cve: "CVE-2026-100",
      stableKey: stableKeyFor("platform-1", component, "CVE-2026-100"),
      status: "IN_TRIAGE",
      justification: null,
      response: null,
      reason: "investigating call paths carefully",
      pin: "exact_version",
      provenance: {
        by: "bb-agent",
        at: "2026-08-15T00:00:00.000Z",
        evidence: "scanner finding retained",
      },
    });

    const host = createFakePluginHost({
      pluginId: `fs-write-cas-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    let calls = 0;
    ctx.service<TriageWriter>(TRIAGE_WRITER_SERVICE, () => ({
      set: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            path: first.file,
            op: "update",
            diffSummary: [
              { field: "status", from: "IN_TRIAGE", to: "NOT_AFFECTED" },
            ],
            omittedDiffs: 0,
            contentHash: "f".repeat(64),
          };
        }
        throw new KnownToolError({
          code: "cas_mismatch",
          message: "Triage overlay changed concurrently.",
          hint: "Reload the current content hash and retry the write; never last-write-wins.",
          retryable: true,
        });
      },
      applyPolicy: vi.fn(),
    }));
    registerWriteTools(host.bb, ctx);

    const winner = parseTool(
      await host.harness.behavior.callAgentTool("fs_triage_set", {
        projectVersionId: "pv-1",
        stableKey: first.stableKey,
        status: "NOT_AFFECTED",
        justification: "CODE_NOT_PRESENT",
        response: null,
        reason: "component binary no longer ships the symbol",
        evidence: "SBOM diff and binary scan",
        expectedHash: first.afterSha256,
      }),
    );
    const loser = parseTool(
      await host.harness.behavior.callAgentTool("fs_triage_set", {
        projectVersionId: "pv-1",
        stableKey: first.stableKey,
        status: "FALSE_POSITIVE",
        justification: null,
        response: null,
        reason: "duplicate scanner signature only",
        evidence: "matched prior closed finding",
        expectedHash: first.afterSha256,
      }),
    );
    expect(winner.ok).toBe(true);
    expect(loser).toMatchObject({
      ok: false,
      error: { code: "cas_mismatch", retryable: true },
    });
  });

  it("partial HBOM batch reports each rejected cell while committing valid proposals atomically per merge contract", async () => {
    const host = createFakePluginHost({
      pluginId: `fs-write-hbom-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    ctx.service<HbomExtractor>(HBOM_EXTRACTOR_SERVICE, () => ({
      merge: async () => ({
        path: "product-security/hbom/hbom.yaml",
        merged: 1,
        queued: 0,
        conflicts: 0,
        candidatesAdded: 0,
        contentHash: "a".repeat(64),
        diffSummary: "merged=1 rejected=1",
        rejected: [
          {
            cell: "1",
            error: {
              code: "HBOM_CONFIDENCE_INVALID",
              message: "confidence must be a number in [0, 1]",
              hint: "Valid proposals still commit atomically; rejected cells were not applied.",
              retryable: false,
            },
          },
        ],
      }),
    }));
    registerWriteTools(host.bb, ctx);
    const result = parseTool(
      await host.harness.behavior.callAgentTool("fs_hbom_extract", {
        projectVersionId: null,
        documentSha256: "b".repeat(64),
        expectedHbomSha256: HBOM_EMPTY_SHA256,
        createMissingParts: true,
        cells: [
          {
            part: { id: "HBOM-0001" },
            field: "mpn",
            value: "ABC-123",
            source_ref: {
              documentSha256: "b".repeat(64),
              locator: { kind: "pdf", page: 1 },
            },
            confidence: 0.9,
          },
          {
            part: { id: "HBOM-0002" },
            field: "mpn",
            value: "XYZ",
            source_ref: {
              documentSha256: "b".repeat(64),
              locator: { kind: "pdf", page: 2 },
            },
            confidence: 0.8,
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        merged: 1,
        rejected: [{ cell: "1", error: { code: "HBOM_CONFIDENCE_INVALID" } }],
      },
    });
  });

  it("module graph contains no remote write/action import", () => {
    const writeSource = readFileSync(join(toolsDir, "write.ts"), "utf8");
    const schemaSource = readFileSync(
      join(toolsDir, "write-schemas.ts"),
      "utf8",
    );
    for (const source of [writeSource, schemaSource]) {
      expect(source).not.toMatch(
        /from ["'][^"']*lib\/remote|PlatformClient|AssuranceStudioClient|ForgeClient/,
      );
      expect(source).not.toMatch(/from ["'][^"']*tools\/actions\.js/);
      expect(source).not.toMatch(/from ["'][^"']*sync\/push/);
      expect(source).not.toMatch(/hbomReviewResolve|applyHbomExtractionRpc/);
    }
    expect(writeSource).toContain("applyHbomExtraction");
    expect(writeSource).not.toContain("applyHbomExtractionRpc");
  });
});
