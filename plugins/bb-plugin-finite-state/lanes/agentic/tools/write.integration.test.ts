import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../../lib/context.js";
import { HBOM_EMPTY_SHA256, writeHbomCas } from "../../bom/hbom/yaml.js";
import { HBOM_SCHEMA_ID } from "../../bom/hbom/types.js";
import { rebuildOverlayIndex } from "../../findings/overlay/indexer.js";
import { setDecision } from "../../findings/overlay/writer.js";
import { stableKeyFor } from "../../findings/overlay/schema.js";
import { registerFindingsRpc } from "../../findings/rpc.js";
import { registerWriteTools } from "./write.js";

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
  error?: { code: string; retryable?: boolean; message?: string };
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

function toolFailed(result: unknown): boolean {
  if (typeof result === "object" && result !== null && "isError" in result) {
    return Reflect.get(result, "isError") === true;
  }
  const parsed = parseTool(result);
  return parsed.ok === false;
}

async function seedFindings(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
  opts: {
    workspaceProjectId: string;
    platformProjectId: string;
    projectVersionId: string;
    findings: Array<{
      findingId: string;
      stableKey: string;
      cve: string;
    }>;
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
  const insert = db.prepare(
    `INSERT INTO findings
      (project_id, project_version_id, generation_id, finding_id, stable_key, cve,
       component_name, component_group, component_version, component_purl,
       in_kev, reachability_score, vuln_in_dataset, reachability_factors, raw, pulled_at)
     VALUES (?, ?, 'generation-1', ?, ?, ?,
             'busybox', NULL, '1.36.1', 'pkg:generic/busybox@1.36.1',
             0, -1, 1, '[]', '{}', ?)`,
  );
  for (const finding of opts.findings) {
    insert.run(
      opts.platformProjectId,
      opts.projectVersionId,
      finding.findingId,
      finding.stableKey,
      finding.cve,
      at,
    );
  }
}

async function triageFixture(opts?: { secondCve?: string }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs-write-fix-")));
  roots.push(root);
  const workspaceProjectId = "workspace-1";
  const platformProjectId = "platform-1";
  const projectVersionId = "version-1";
  const component = {
    purl: "pkg:generic/busybox@1.36.1",
    name: "busybox",
    group: null as string | null,
    version: "1.36.1",
  };
  const stableKey = stableKeyFor(platformProjectId, component, "CVE-2026-100");
  const findings = [{ findingId: "finding-1", stableKey, cve: "CVE-2026-100" }];
  let secondStableKey: string | undefined;
  if (opts?.secondCve) {
    secondStableKey = stableKeyFor(
      platformProjectId,
      component,
      opts.secondCve,
    );
    findings.push({
      findingId: "finding-2",
      stableKey: secondStableKey,
      cve: opts.secondCve,
    });
  }
  const host = createFakePluginHost({
    pluginId: `fs-write-fix-${crypto.randomUUID()}`,
    sdk: {
      projects: {
        get: ({ projectId }: { projectId: string }) => ({
          id: projectId,
          sources: [{ hostId: "host-1", path: root, isDefault: true }],
        }),
      },
      files: {
        read: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        write: async () => ({
          outcome: "written" as const,
          sha256: "c".repeat(64),
          sizeBytes: 1,
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
    findings,
  });
  registerWriteTools(host.bb, ctx);
  registerFindingsRpc(host.bb, ctx.db(), {});
  return {
    root,
    host,
    ctx,
    workspaceProjectId,
    platformProjectId,
    projectVersionId,
    component,
    stableKey,
    secondStableKey,
  };
}

describe("write tool integration", () => {
  it("callAgentTool writes YAML, updates watcher index, and status reports local change", async () => {
    const fixture = await triageFixture();
    const result = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.stableKey,
          status: "IN_TRIAGE",
          justification: null,
          response: null,
          reason: "investigating call paths carefully",
          evidence: "scanner finding and call graph retained",
        },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      op: "create",
      path: expect.stringMatching(/^\.fs\/triage\//),
    });
    const path = String(result.data?.path);
    const written = await readFile(join(fixture.root, path), "utf8");
    expect(written).toContain("CVE-2026-100:");
    expect(written).toContain("IN_TRIAGE");
    const index = await rebuildOverlayIndex(fixture.ctx.db(), fixture.root);
    expect(index.indexed).toBeGreaterThan(0);
    expect(
      fixture.host.harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "findings:changed",
      ),
    ).toBe(true);
  });

  it("two writers with same expected hash yield one success and one cas_mismatch", async () => {
    const fixture = await triageFixture({ secondCve: "CVE-2026-200" });
    const created = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.stableKey,
          status: "IN_TRIAGE",
          justification: null,
          response: null,
          reason: "investigating call paths carefully",
          evidence: "scanner finding retained for first decision",
        },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    expect(created.ok).toBe(true);
    const expectedHash = String(created.data?.contentHash);

    const winner = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.secondStableKey,
          status: "NOT_AFFECTED",
          justification: "CODE_NOT_PRESENT",
          response: null,
          reason: "component binary no longer ships the symbol",
          evidence: "SBOM diff and binary scan retained",
          expectedHash,
        },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    const loser = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.stableKey,
          status: "FALSE_POSITIVE",
          justification: null,
          response: null,
          reason: "duplicate scanner signature only here",
          evidence: "matched prior closed finding evidence",
          expectedHash,
        },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    expect(winner.ok).toBe(true);
    expect(loser).toMatchObject({
      ok: false,
      error: { code: "cas_mismatch", retryable: true },
    });
  });

  it("omitting expectedHash on an existing overlay refuses last-write-wins clobber", async () => {
    const fixture = await triageFixture();
    await setDecision(fixture.root, {
      project: fixture.platformProjectId,
      component: fixture.component,
      cve: "CVE-2026-100",
      stableKey: fixture.stableKey,
      status: "IN_TRIAGE",
      justification: null,
      response: null,
      reason: "seed decision for omit-hash clobber fence",
      pin: "exact_version",
      provenance: {
        by: "bb-agent",
        at: "2026-08-15T00:00:00.000Z",
        evidence: "seed evidence for omit-hash clobber fence",
      },
    });

    const [left, right] = await Promise.all([
      fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.stableKey,
          status: "NOT_AFFECTED",
          justification: "CODE_NOT_PRESENT",
          response: null,
          reason: "left concurrent writer omits expectedHash",
          evidence: "left evidence for omit-hash clobber fence",
        },
        { projectId: fixture.workspaceProjectId },
      ),
      fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.stableKey,
          status: "FALSE_POSITIVE",
          justification: null,
          response: null,
          reason: "right concurrent writer omits expectedHash",
          evidence: "right evidence for omit-hash clobber fence",
        },
        { projectId: fixture.workspaceProjectId },
      ),
    ]);
    const outcomes = [parseTool(left), parseTool(right)];
    expect(outcomes.filter((item) => item.ok)).toHaveLength(0);
    expect(
      outcomes.filter(
        (item) =>
          item.ok === false &&
          item.error?.code === "cas_mismatch" &&
          item.error.retryable === true,
      ),
    ).toHaveLength(2);
    const yaml = await readFile(
      join(fixture.root, ".fs/triage/platform-1/busybox.yaml"),
      "utf8",
    );
    expect(yaml).toContain("IN_TRIAGE");
    expect(yaml).not.toMatch(/status:\s+(NOT_AFFECTED|FALSE_POSITIVE)/);
  });

  it("rejects adversarial requirement destinations off tracked YAML roots", async () => {
    const writes: unknown[] = [];
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fs-write-boundary-")),
    );
    roots.push(root);
    const host = createFakePluginHost({
      pluginId: `fs-write-boundary-${crypto.randomUUID()}`,
      sdk: {
        projects: {
          get: () => ({
            sources: [{ hostId: "host-1", path: root, isDefault: true }],
          }),
        },
        files: {
          read: async () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          },
          write: async (input: unknown) => {
            writes.push(input);
            return {
              outcome: "written" as const,
              sha256: "d".repeat(64),
              sizeBytes: 1,
            };
          },
        },
      },
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    registerWriteTools(host.bb, ctx);

    const attacks = [
      "REQ-../escape",
      "REQ-/absolute",
      "REQ-.git",
      "REQ-..",
      "REQ-foo/bar",
    ];
    for (const reqId of attacks) {
      let failed = false;
      try {
        const raw = await host.harness.behavior.callAgentTool(
          "fs_requirement_write",
          {
            reqId,
            yaml: {
              schema: "fs-requirement/v1",
              id: reqId,
              req_type: "security",
              priority: "P1",
              status: "draft",
              ears: {
                pattern: "ubiquitous",
                text: "The gateway SHALL reject unsigned firmware",
                parts: {
                  system: "gateway",
                  response: "reject unsigned firmware",
                },
              },
              source_description: "Protect the update trust boundary.",
              mitigations: [],
              controls: [],
              standards: [],
              verification: [],
            },
          },
          { projectId: "workspace-1" },
        );
        failed = toolFailed(raw) || parseTool(raw).ok === false;
      } catch (error) {
        failed =
          error instanceof Error &&
          /invalid|REQ-\*|path|escape|separators/iu.test(error.message);
      }
      expect(failed, reqId).toBe(true);
    }
    expect(writes).toHaveLength(0);
    expect(readFileSync(join(toolsDir, "write.ts"), "utf8")).toContain(
      "assertSafeRequirementId",
    );
    expect(readFileSync(join(toolsDir, "write-schemas.ts"), "utf8")).toMatch(
      /REQ-\[A-Za-z0-9\]\[A-Za-z0-9-\]\*/,
    );
  });

  it("CODE_NOT_REACHABLE through the default writer forces exact_version pin", async () => {
    const fixture = await triageFixture();
    const result = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_set",
        {
          projectVersionId: fixture.projectVersionId,
          stableKey: fixture.stableKey,
          status: "NOT_AFFECTED",
          justification: "CODE_NOT_REACHABLE",
          response: null,
          reason: "dead call path proved by the attached trace",
          evidence: "call graph shows no reachable use of the symbol",
        },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    expect(result.ok).toBe(true);
    const path = String(result.data?.path);
    const yaml = await readFile(join(fixture.root, path), "utf8");
    expect(yaml).toContain("pin: exact_version");
    expect(yaml).not.toContain("pin: any_version");
  });

  it("policy holds KEV through the real policy engine dry-run", async () => {
    const fixture = await triageFixture();
    await mkdir(join(fixture.root, ".fs", "triage"), { recursive: true });
    await writeFile(
      join(fixture.root, ".fs", "triage", "policy.yaml"),
      `schema: fs-triage-policy/v1
rules:
  - name: unreachable-not-affected
    when:
      reachability: unreachable
      vuln_in_dataset: true
    set:
      status: NOT_AFFECTED
      justification: CODE_NOT_REACHABLE
      response: null
      reason: Unreachable in this build
      pin: exact_version
holdback:
  - kev: true
options:
  overwrite_existing: false
`,
      "utf8",
    );
    // Mark the seeded finding as KEV so the holdback fires.
    fixture.ctx
      .db()
      .prepare(
        `UPDATE findings SET in_kev = 1, reachability_score = -1, vuln_in_dataset = 1
          WHERE finding_id = 'finding-1'`,
      )
      .run();

    const result = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_apply_policy",
        { projectVersionId: fixture.projectVersionId, dryRun: true },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      written: 0,
    });
    const held = result.data?.held;
    expect(Array.isArray(held)).toBe(true);
    expect(held).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: fixture.stableKey,
          why: expect.stringMatching(/kev/i),
        }),
      ]),
    );
  });

  it("persists a truthful partial policy run on abort and converges on rerun", async () => {
    const fixture = await triageFixture({ secondCve: "CVE-2026-200" });
    const thirdCve = "CVE-2026-300";
    const thirdStableKey = stableKeyFor(
      fixture.platformProjectId,
      fixture.component,
      thirdCve,
    );
    fixture.ctx
      .db()
      .prepare(
        `INSERT INTO findings
          (project_id, project_version_id, generation_id, finding_id, stable_key, cve,
           component_name, component_group, component_version, component_purl,
           in_kev, reachability_score, vuln_in_dataset, reachability_factors, raw, pulled_at)
         VALUES (?, ?, 'generation-1', 'finding-3', ?, ?,
                 'busybox', NULL, '1.36.1', 'pkg:generic/busybox@1.36.1',
                 0, -1, 1, '[]', '{}', '2026-08-15T00:00:00.000Z')`,
      )
      .run(
        fixture.platformProjectId,
        fixture.projectVersionId,
        thirdStableKey,
        thirdCve,
      );
    await mkdir(join(fixture.root, ".fs", "triage"), { recursive: true });
    await writeFile(
      join(fixture.root, ".fs", "triage", "policy.yaml"),
      `schema: fs-triage-policy/v1
rules:
  - name: unreachable-not-affected
    when:
      reachability: unreachable
      vuln_in_dataset: true
    set:
      status: NOT_AFFECTED
      justification: CODE_NOT_REACHABLE
      response: null
      reason: Unreachable in this build
      pin: exact_version
holdback: []
options:
  overwrite_existing: false
`,
      "utf8",
    );

    const controller = new AbortController();
    const nativeThrowIfAborted = controller.signal.throwIfAborted.bind(
      controller.signal,
    );
    let abortChecks = 0;
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value() {
        abortChecks += 1;
        // Interrupt at the outer-loop check before the third candidate, after
        // the first two overlay writes have completed successfully.
        if (abortChecks === 5) {
          controller.abort(
            new DOMException("interrupted after two writes", "AbortError"),
          );
        }
        nativeThrowIfAborted();
      },
    });

    const interrupted = await fixture.host.harness.behavior.callAgentTool(
      "fs_triage_apply_policy",
      { projectVersionId: fixture.projectVersionId, dryRun: false },
      { projectId: fixture.workspaceProjectId, signal: controller.signal },
    );
    expect(toolFailed(interrupted)).toBe(true);

    const partial = fixture.ctx
      .db()
      .prepare<
        [],
        {
          run_id: string;
          status: string;
          written: number;
          held: number;
          skipped_existing: number;
          errors: number;
        }
      >(
        `SELECT run_id, status, written, held, skipped_existing, errors
           FROM triage_runs
          WHERE source = 'policy'`,
      )
      .get();
    expect(partial).toMatchObject({
      status: "partial",
      written: 2,
      held: 0,
      skipped_existing: 0,
      errors: 0,
    });

    const summary = await fixture.host.harness.behavior.callRpc(
      "triageSummaryGet",
      {
        projectId: fixture.platformProjectId,
        projectVersionId: fixture.projectVersionId,
        runId: partial?.run_id,
      },
    );
    expect(summary).toMatchObject({
      status: "partial",
      written: 2,
      held: 0,
      skippedExisting: 0,
      errors: 0,
    });

    const rerun = parseTool(
      await fixture.host.harness.behavior.callAgentTool(
        "fs_triage_apply_policy",
        { projectVersionId: fixture.projectVersionId, dryRun: false },
        { projectId: fixture.workspaceProjectId },
      ),
    );
    expect(rerun).toMatchObject({
      ok: true,
      data: { written: 1, skippedExisting: 2, errors: [] },
    });
    const authored = await readFile(
      join(fixture.root, ".fs/triage/platform-1/busybox.yaml"),
      "utf8",
    );
    expect(authored).toContain("CVE-2026-100:");
    expect(authored).toContain("CVE-2026-200:");
    expect(authored).toContain("CVE-2026-300:");
    expect(
      fixture.ctx
        .db()
        .prepare(
          `SELECT status, written, skipped_existing, errors
             FROM triage_runs
            ORDER BY created_at, rowid`,
        )
        .all(),
    ).toEqual([
      {
        status: "partial",
        written: 2,
        skipped_existing: 0,
        errors: 0,
      },
      {
        status: "completed",
        written: 1,
        skipped_existing: 2,
        errors: 0,
      },
    ]);
  });

  it("does not fabricate a write error when aborting inside a failed write", async () => {
    const fixture = await triageFixture();
    await mkdir(join(fixture.root, ".fs", "triage"), { recursive: true });
    await writeFile(
      join(fixture.root, ".fs", "triage", "policy.yaml"),
      `schema: fs-triage-policy/v1
rules:
  - name: unreachable-not-affected
    when:
      reachability: unreachable
      vuln_in_dataset: true
    set:
      status: NOT_AFFECTED
      justification: CODE_NOT_REACHABLE
      response: null
      reason: Unreachable in this build
      pin: exact_version
holdback: []
options:
  overwrite_existing: false
`,
      "utf8",
    );
    await writeFile(
      join(fixture.root, ".fs", "triage", fixture.platformProjectId),
      "blocks the project overlay directory",
      "utf8",
    );

    const controller = new AbortController();
    const nativeThrowIfAborted = controller.signal.throwIfAborted.bind(
      controller.signal,
    );
    let abortChecks = 0;
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value() {
        abortChecks += 1;
        // The third (odd-numbered) check is the write-error guard: abort here
        // to model cancellation arriving while the overlay write is failing.
        if (abortChecks === 3) {
          controller.abort(
            new DOMException("interrupted inside overlay write", "AbortError"),
          );
        }
        nativeThrowIfAborted();
      },
    });

    const interrupted = await fixture.host.harness.behavior.callAgentTool(
      "fs_triage_apply_policy",
      { projectVersionId: fixture.projectVersionId, dryRun: false },
      { projectId: fixture.workspaceProjectId, signal: controller.signal },
    );
    expect(toolFailed(interrupted)).toBe(true);
    expect(abortChecks).toBe(3);
    expect(
      fixture.ctx
        .db()
        .prepare(
          `SELECT status, written, skipped_existing, errors
             FROM triage_runs
            WHERE source = 'policy'`,
        )
        .get(),
    ).toEqual({
      status: "partial",
      written: 0,
      skipped_existing: 0,
      errors: 0,
    });
  });

  it("partial HBOM batch reports rejected cells through applyHbomExtraction", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fs-write-hbom-")),
    );
    roots.push(root);
    await mkdir(join(root, "product-security/hbom"), { recursive: true });
    await mkdir(join(root, "product-security/documents"), { recursive: true });
    const docSha = "a".repeat(64);
    const host = createFakePluginHost({
      pluginId: `fs-write-hbom-${crypto.randomUUID()}`,
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
    const at = "2026-08-15T00:00:00.000Z";
    ctx
      .db()
      .prepare(
        `INSERT INTO document (
           project_id, project_version_id, document_id, sha256, name, path,
           doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at,
           analyzed_by, analyzed_at, cells_extracted, indexed_at
         ) VALUES ('workspace-1', '@project', 'doc-1', ?, 'datasheet.pdf',
                   'product-security/documents/datasheet.pdf', 'datasheet',
                   'application/pdf', 12, 0, 0, ?, NULL, NULL, 0, ?)`,
      )
      .run(docSha, at, at);
    const expectedHbomSha256 = await writeHbomCas(root, HBOM_EMPTY_SHA256, {
      schema: HBOM_SCHEMA_ID,
      project: "acme-router",
      options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
      parts: [{ id: "HBOM-0001", asComponentId: null }],
    });
    registerWriteTools(host.bb, ctx);

    const result = parseTool(
      await host.harness.behavior.callAgentTool(
        "fs_hbom_extract",
        {
          projectVersionId: null,
          documentSha256: docSha,
          expectedHbomSha256,
          createMissingParts: false,
          cells: [
            {
              part: { id: "HBOM-0001" },
              field: "mpn",
              value: "ABC-123",
              source_ref: {
                documentSha256: docSha,
                locator: { kind: "pdf", page: 1 },
              },
              confidence: 0.95,
            },
            {
              part: { id: "HBOM-missing" },
              field: "mpn",
              value: "MISSING",
              source_ref: {
                documentSha256: docSha,
                locator: { kind: "pdf", page: 2 },
              },
              confidence: 0.9,
            },
          ],
        },
        { projectId: "workspace-1" },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      merged: 1,
      path: "product-security/hbom/hbom.yaml",
    });
    expect(result.data?.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.objectContaining({ code: "HBOM_PART_NOT_FOUND" }),
        }),
      ]),
    );
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
