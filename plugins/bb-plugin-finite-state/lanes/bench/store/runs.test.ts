import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { storeEvidenceCheckpointWithResult } from "./results.js";
import { getBenchRun, listBenchRuns } from "./runs.js";
import { createBenchTestStore, evidenceBundle, SYNCED_AT } from "./test-helpers.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("bench runs repository", () => {
  it("orders newest first with a deterministic same-time run-id tie break and pages", () => {
    const fixture = createBenchTestStore("runs-page");
    hosts.push(fixture.host);
    for (const runId of ["run-a", "run-c", "run-b"]) {
      storeEvidenceCheckpointWithResult(
        fixture.db,
        evidenceBundle({ run: { ...evidenceBundle().run, runId } }),
        SYNCED_AT,
      );
    }
    const first = listBenchRuns(fixture.db, {
      projectId: "project-a",
      pvId: "version-a",
      pageSize: 2,
      continuation: null,
      now: "2026-08-12T20:01:00.000Z",
    });
    expect(first.items.map((run) => run.runId)).toEqual(["run-c", "run-b"]);
    expect(first.total).toBe(3);
    expect(first.next).not.toBeNull();
    expect(first.cache).toMatchObject({ state: "fresh", baseRevision: 7 });
    const second = listBenchRuns(fixture.db, {
      projectId: "project-a",
      pvId: "version-a",
      pageSize: 2,
      continuation: first.next,
      now: "2026-08-12T20:01:00.000Z",
    });
    expect(second.items.map((run) => run.runId)).toEqual(["run-a"]);
    expect(second.next).toBeNull();
  });

  it("is idempotent and reports unknown runs without leaking another scope", () => {
    const fixture = createBenchTestStore("runs-idempotent");
    hosts.push(fixture.host);
    expect(storeEvidenceCheckpointWithResult(fixture.db, evidenceBundle(), SYNCED_AT).changed).toBe(
      true,
    );
    expect(storeEvidenceCheckpointWithResult(fixture.db, evidenceBundle(), SYNCED_AT).changed).toBe(
      false,
    );
    expect(
      getBenchRun(fixture.db, {
        projectId: "project-a",
        pvId: "version-a",
        runId: "missing",
      }),
    ).toBeNull();
  });

  it("allows polling to advance status and log cursor without deleting evidence", () => {
    const fixture = createBenchTestStore("runs-poll");
    hosts.push(fixture.host);
    storeEvidenceCheckpointWithResult(
      fixture.db,
      evidenceBundle({
        run: {
          ...evidenceBundle().run,
          status: "running",
          finishedAt: null,
          logLocator: "runs/run-a/log.ndjson",
          logCursor: "10",
        },
        artifacts: [
          { name: "report", kind: "json", locator: "runs/run-a/report.json", sha256: null, bytes: 2 },
        ],
      }),
      SYNCED_AT,
    );
    storeEvidenceCheckpointWithResult(
      fixture.db,
      evidenceBundle({
        run: { ...evidenceBundle().run, status: "completed", logCursor: "20" },
      }),
      "2026-08-12T20:02:00.000Z",
    );
    expect(fixture.db.prepare("SELECT COUNT(*) FROM verification_artifacts").pluck().get()).toBe(1);
    expect(
      fixture.db
        .prepare("SELECT status, log_locator, log_cursor FROM verification_runs")
        .get(),
    ).toEqual({
      status: "completed",
      log_locator: "runs/run-a/log.ndjson",
      log_cursor: "20",
    });
  });
});
