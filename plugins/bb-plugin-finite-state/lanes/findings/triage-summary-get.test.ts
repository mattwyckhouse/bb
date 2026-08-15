import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginContext } from "../../lib/context.js";
import { findingsUiRpcContract, registerFindingsRpc } from "./rpc.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

describe("triageSummaryGet (FS-229 / AMD-0025 lane-local)", () => {
  it("returns durable triage_runs summary with bounded holdbacks", async () => {
    const host = createFakePluginHost({ pluginId: "finite-state" });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    registerFindingsRpc(host.bb, ctx.db(), {});
    const db = ctx.db();
    const report = {
      runId: "tr-20260811-1402",
      policySha256: "a".repeat(64),
      dryRun: false,
      rules: [],
      written: 39,
      held: [
        {
          stableKey: "acme|pkg:generic/busybox@1|CVE-2023-1",
          rule: "hold-kev",
          why: "KEV requires human review",
        },
      ],
      skippedExisting: 1,
      errors: [],
    };
    db.prepare(
      `INSERT INTO triage_runs
        (project_id, project_version_id, run_id, source, dry_run, status,
         input_digest, written, held, conflicts, skipped_existing, errors,
         report_json, created_at, finished_at)
       VALUES (?, ?, ?, 'policy', 0, 'completed', ?, 39, 1, 0, 1, 0, ?, ?, ?)`,
    ).run(
      "platform-1",
      "version-1",
      "tr-20260811-1402",
      "a".repeat(64),
      JSON.stringify(report),
      "2026-08-15T00:00:00.000Z",
      "2026-08-15T00:01:00.000Z",
    );

    const summary = findingsUiRpcContract.triageSummaryGet.output.parse(
      await host.harness.behavior.callRpc("triageSummaryGet", {
        projectId: "platform-1",
        projectVersionId: "version-1",
        runId: "tr-20260811-1402",
      }),
    );
    expect(summary).toMatchObject({
      runId: "tr-20260811-1402",
      source: "policy",
      status: "completed",
      written: 39,
      held: 1,
      skippedExisting: 1,
    });
    expect(summary.holdbacks).toEqual([
      {
        stableKey: "acme|pkg:generic/busybox@1|CVE-2023-1",
        rule: "hold-kev",
        why: "KEV requires human review",
      },
    ]);

    await expect(
      host.harness.behavior.callRpc("triageSummaryGet", {
        projectId: "platform-1",
        projectVersionId: "version-1",
        runId: "missing",
      }),
    ).rejects.toThrow(/TRIAGE_RUN_NOT_FOUND/u);
  });
});
