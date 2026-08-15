import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../lib/context.js";
import { rpcContract } from "../../shared/contract.js";
import { stableKeyFor } from "./overlay/index.js";
import { registerFindingsPolicy } from "./policy/register.js";
import { registerFindingsRpc } from "./rpc.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function seedAcceptedFinding(
  db: Database.Database,
  input: {
    platformProjectId: string;
    projectVersionId: string;
    findingId?: string;
    componentName?: string;
    cve?: string;
    reachabilityScore?: number;
  },
): string {
  const generationId = "generation-1";
  const findingId = input.findingId ?? "finding-1";
  const componentName = input.componentName ?? "controller";
  const cve = input.cve ?? "CVE-2026-2200";
  const component = {
    purl: `pkg:generic/${componentName}@1.0.0`,
    name: componentName,
    group: null,
    version: "1.0.0",
  };
  const stableKey = stableKeyFor(input.platformProjectId, component, cve);
  db.prepare(
    `INSERT OR IGNORE INTO pull_generation
      (project_id, project_version_id, generation_id, status,
       requested_kinds_json, started_at, completed_at, accepted_at)
     VALUES (?, ?, ?, 'accepted', '["finding"]', ?, ?, ?)`,
  ).run(
    input.platformProjectId,
    input.projectVersionId,
    generationId,
    "2026-08-14T12:00:00.000Z",
    "2026-08-14T12:00:00.000Z",
    "2026-08-14T12:00:00.000Z",
  );
  db.prepare(
    `INSERT OR IGNORE INTO sync_state
      (project_id, project_version_id, entity_kind, accepted_generation_id,
       base_revision, last_pull)
     VALUES (?, ?, 'finding', ?, 1, ?)`,
  ).run(
    input.platformProjectId,
    input.projectVersionId,
    generationId,
    "2026-08-14T12:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO findings
      (project_id, project_version_id, generation_id, finding_id, stable_key,
       finding_type, cve, component_name, component_version, component_purl,
       severity, band, epss_score, in_kev, in_vc_kev, reachability_score,
       reachability_factors, vuln_in_dataset, cwes, raw, pulled_at)
     VALUES (?, ?, ?, ?, ?, 'vulnerability', ?, ?, '1.0.0', ?,
             'HIGH', 'HIGH', 0.7, 0, 0, ?, '[{"label":"callers","value":"none"}]',
             1, '["CWE-20"]', '{}', ?)`,
  ).run(
    input.platformProjectId,
    input.projectVersionId,
    generationId,
    findingId,
    stableKey,
    cve,
    componentName,
    component.purl,
    input.reachabilityScore ?? -1,
    "2026-08-14T12:00:00.000Z",
  );
  return stableKey;
}

async function testRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeUnreachablePolicy(root: string): Promise<void> {
  await mkdir(join(root, ".fs", "triage"), { recursive: true });
  await writeFile(
    join(root, ".fs", "triage", "policy.yaml"),
    `schema: fs-triage-policy/v1
rules:
  - name: unreachable
    when:
      reachability: unreachable
    set:
      status: NOT_AFFECTED
      justification: CODE_NOT_REACHABLE
      reason: "No callers: {factors}"
      pin: exact_version
holdback: []
options:
  overwrite_existing: false
`,
    "utf8",
  );
}

function findingsViewColumns(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>("PRAGMA table_info(findings)")
    .all()
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`);
}

function restoreFindingsTable(db: Database.Database): void {
  db.exec(`DROP VIEW findings;
    ALTER TABLE findings_fs233_source RENAME TO findings;`);
}

async function worktreeSnapshot(
  root: string,
  directory = root,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await worktreeSnapshot(root, path));
    } else if (entry.isFile()) {
      snapshot[relative(root, path)] = (await readFile(path)).toString(
        "base64",
      );
    }
  }
  return snapshot;
}

describe("FS-220 findings frozen registrations", () => {
  it("registers the singular and bulk frozen decision shapes over the CAS writer", async () => {
    const root = await testRoot("fs220-decisions-");
    const workspaceProjectId = "workspace-project";
    const platformProjectId = "platform-project";
    const projectVersionId = "version-1";
    const host = createFakePluginHost({
      pluginId: "fs220-decision-rpcs",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [{ hostId: "host-1", path: root, isDefault: true }],
          }),
        },
      },
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const stableKey = seedAcceptedFinding(db, {
      platformProjectId,
      projectVersionId,
    });
    const chainedStableKey = seedAcceptedFinding(db, {
      platformProjectId,
      projectVersionId,
      findingId: "finding-2",
      cve: "CVE-2026-2201",
    });
    db.prepare(
      `INSERT INTO workspace_platform_project_binding
        (workspace_project_id, platform_project_id)
       VALUES (?, ?)`,
    ).run(workspaceProjectId, platformProjectId);
    registerFindingsRpc(host.bb, db);

    const single = rpcContract.triageDecisionWrite.output.parse(
      await host.harness.behavior.callRpc("triageDecisionWrite", {
        projectId: workspaceProjectId,
        projectVersionId,
        stableKey,
        status: "IN_TRIAGE",
        response: null,
        justification: null,
        reason: "Needs investigation",
        evidence: "No exploit path was observed",
        pin: "exact_version",
        expectedContentSha256: null,
      }),
    );
    expect(single).toMatchObject({
      projectId: workspaceProjectId,
      projectVersionId,
      stableKey,
      beforeSha256: null,
      afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(single.changedFields).toContain("status");

    const bulk = rpcContract.triageDecisionBulkWrite.output.parse(
      await host.harness.behavior.callRpc("triageDecisionBulkWrite", {
        projectId: workspaceProjectId,
        projectVersionId,
        decisions: [
          {
            stableKey,
            status: "RESOLVED",
            response: null,
            justification: null,
            reason: "fixed",
            evidence: "local verification",
            pin: "exact_version",
            expectedContentSha256: single.afterSha256,
          },
          {
            stableKey: chainedStableKey,
            status: "NOT_AFFECTED",
            response: null,
            justification: "CODE_NOT_REACHABLE",
            reason: "stale same-file expectation",
            evidence: "local verification",
            pin: "exact_version",
            expectedContentSha256: "f".repeat(64),
          },
          {
            stableKey: "missing-stable-key",
            status: "IN_TRIAGE",
            response: null,
            justification: null,
            reason: "unknown",
            evidence: "none",
            pin: "exact_version",
            expectedContentSha256: null,
          },
        ],
      }),
    );
    expect(bulk).toMatchObject({
      projectId: workspaceProjectId,
      projectVersionId,
      total: 3,
      applied: 1,
      failed: 2,
      results: [
        { stableKey, success: true, error: null },
        {
          stableKey: chainedStableKey,
          success: false,
          error: { code: "OVERLAY_CAS_CONFLICT" },
        },
        {
          stableKey: "missing-stable-key",
          success: false,
          error: { code: "TRIAGE_WRITE_FAILED" },
        },
      ],
    });
    expect(bulk.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(host.harness.inspection.registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "triageDecisionWrite",
        "triageDecisionBulkWrite",
      ]),
    );
  });

  it("registers policy preview/apply and refuses replay before side effects", async () => {
    const root = await testRoot("fs220-policy-");
    await writeUnreachablePolicy(root);
    const host = createFakePluginHost({ pluginId: "fs220-policy-rpcs" });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const platformProjectId = "platform-project";
    const projectVersionId = "version-1";
    seedAcceptedFinding(db, {
      platformProjectId,
      projectVersionId,
      reachabilityScore: -1,
    });
    registerFindingsPolicy(host.bb, db, async () => ({
      root,
      platformProjectId,
      projectVersionId,
    }));

    const preview = rpcContract.triagePolicyPreview.output.parse(
      await host.harness.behavior.callRpc("triagePolicyPreview", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
      }),
    );
    expect(preview).toMatchObject({
      projectId: "workspace-project",
      projectVersionId,
      total: 1,
      next: null,
      written: 0,
      held: 0,
      errors: 0,
      items: [
        {
          kind: "triagePolicyRun",
          fields: {
            policySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            wouldWrite: 1,
          },
        },
      ],
    });
    const policySha256 = preview.items[0]!.fields["policySha256"];
    expect(typeof policySha256).toBe("string");

    const applied = rpcContract.triagePolicyApply.output.parse(
      await host.harness.behavior.callRpc("triagePolicyApply", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
        runId: preview.runId,
        expectedPolicySha256: policySha256,
      }),
    );
    expect(applied).toMatchObject({
      runId: preview.runId,
      written: 1,
      held: 0,
      errors: 0,
      total: 1,
      next: null,
    });
    expect(
      db
        .prepare("SELECT source, written FROM triage_runs WHERE run_id = ?")
        .get(preview.runId),
    ).toEqual({ source: "policy", written: 1 });

    await rm(join(root, ".fs", "triage", platformProjectId, "controller.yaml"));
    const worktreeBeforeReplay = await worktreeSnapshot(root);
    const ledgerBeforeReplay = db
      .prepare(
        `SELECT *
           FROM triage_runs
          ORDER BY project_id, project_version_id, run_id`,
      )
      .all();
    await expect(
      host.harness.behavior.callRpc("triagePolicyApply", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
        runId: preview.runId,
        expectedPolicySha256: policySha256,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message:
        "POLICY_ALREADY_APPLIED: policy run id is already recorded; preview again before applying",
    });
    expect(await worktreeSnapshot(root)).toEqual(worktreeBeforeReplay);
    expect(
      db
        .prepare(
          `SELECT *
             FROM triage_runs
            ORDER BY project_id, project_version_id, run_id`,
        )
        .all(),
    ).toEqual(ledgerBeforeReplay);
    expect(host.harness.inspection.registrations.rpcMethods).toEqual(
      expect.arrayContaining(["triagePolicyPreview", "triagePolicyApply"]),
    );
  });

  it("persists a real partial write, consumes that preview, and accepts a fresh preview", async () => {
    const root = await testRoot("fs233-policy-partial-");
    await writeUnreachablePolicy(root);
    const host = createFakePluginHost({ pluginId: "fs233-policy-partial" });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const platformProjectId = "platform-project";
    const projectVersionId = "version-1";
    const stableKeys = [
      seedAcceptedFinding(db, {
        platformProjectId,
        projectVersionId,
        findingId: "finding-1",
        componentName: "controller-a",
        cve: "CVE-2026-2331",
      }),
      seedAcceptedFinding(db, {
        platformProjectId,
        projectVersionId,
        findingId: "finding-2",
        componentName: "controller-b",
        cve: "CVE-2026-2332",
      }),
    ].sort();
    registerFindingsPolicy(host.bb, db, async () => ({
      root,
      platformProjectId,
      projectVersionId,
    }));

    const preview = rpcContract.triagePolicyPreview.output.parse(
      await host.harness.behavior.callRpc("triagePolicyPreview", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
      }),
    );
    const policySha256 = preview.items[0]?.fields["policySha256"];
    if (typeof policySha256 !== "string") {
      throw new Error("Expected policy preview SHA-256");
    }

    const columns = findingsViewColumns(db);
    const failingStableKey = stableKeys[1];
    db.function(
      "fs233_vex_status",
      (stableKey: string, value: string | null) => {
        if (stableKey === failingStableKey) {
          throw new Error("FS233_MID_RUN_SQLITE_FAILURE");
        }
        return value;
      },
    );
    db.exec(`ALTER TABLE findings RENAME TO findings_fs233_source;
      CREATE VIEW findings AS SELECT ${columns
        .map((column) =>
          column === '"vex_status"'
            ? `fs233_vex_status("stable_key", "vex_status") AS "vex_status"`
            : column,
        )
        .join(", ")} FROM findings_fs233_source;`);

    await expect(
      host.harness.behavior.callRpc("triagePolicyApply", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
        runId: preview.runId,
        expectedPolicySha256: policySha256,
      }),
    ).rejects.toMatchObject({ code: "handler_error" });
    expect(
      db
        .prepare(
          `SELECT run_id, status, written, errors
             FROM triage_runs
            WHERE source = 'policy'`,
        )
        .get(),
    ).toEqual({
      run_id: preview.runId,
      status: "partial",
      written: 1,
      errors: 0,
    });

    restoreFindingsTable(db);
    await expect(
      host.harness.behavior.callRpc("triagePolicyApply", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
        runId: preview.runId,
        expectedPolicySha256: policySha256,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message:
        "POLICY_ALREADY_APPLIED: policy run id is already recorded; preview again before applying",
    });

    const freshPreview = rpcContract.triagePolicyPreview.output.parse(
      await host.harness.behavior.callRpc("triagePolicyPreview", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
      }),
    );
    const freshPolicySha256 =
      freshPreview.items[0]?.fields["policySha256"];
    if (typeof freshPolicySha256 !== "string") {
      throw new Error("Expected fresh policy preview SHA-256");
    }
    const applied = rpcContract.triagePolicyApply.output.parse(
      await host.harness.behavior.callRpc("triagePolicyApply", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
        runId: freshPreview.runId,
        expectedPolicySha256: freshPolicySha256,
      }),
    );
    expect(applied).toMatchObject({
      runId: freshPreview.runId,
      written: 1,
      errors: 0,
    });
  });

  it("rethrows the original apply failure when partial-report persistence also fails", async () => {
    const root = await testRoot("fs233-policy-original-error-");
    await writeUnreachablePolicy(root);
    const host = createFakePluginHost({
      pluginId: "fs233-policy-original-error",
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const platformProjectId = "platform-project";
    const projectVersionId = "version-1";
    seedAcceptedFinding(db, { platformProjectId, projectVersionId });
    registerFindingsPolicy(host.bb, db, async () => ({
      root,
      platformProjectId,
      projectVersionId,
    }));

    const preview = rpcContract.triagePolicyPreview.output.parse(
      await host.harness.behavior.callRpc("triagePolicyPreview", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
      }),
    );
    const policySha256 = preview.items[0]?.fields["policySha256"];
    if (typeof policySha256 !== "string") {
      throw new Error("Expected policy preview SHA-256");
    }

    const columnsWithoutVexStatus = findingsViewColumns(db).filter(
      (column) => column !== '"vex_status"',
    );
    db.exec(`ALTER TABLE findings RENAME TO findings_fs233_source;
      CREATE VIEW findings AS SELECT ${columnsWithoutVexStatus.join(", ")}
        FROM findings_fs233_source;
      CREATE TRIGGER fs233_fail_partial_report
        BEFORE INSERT ON triage_runs
        WHEN NEW.source = 'policy'
      BEGIN
        SELECT RAISE(ABORT, 'FS233_PERSIST_REPORT_FAILURE');
      END;`);

    await expect(
      host.harness.behavior.callRpc("triagePolicyApply", {
        projectId: "workspace-project",
        projectVersionId,
        pageSize: 50,
        continuation: null,
        runId: preview.runId,
        expectedPolicySha256: policySha256,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: expect.stringContaining("no such column: f.vex_status"),
    });
  });
});
