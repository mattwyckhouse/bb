import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { listBenchResults, storeEvidenceCheckpointWithResult } from "./results.js";
import {
  createBenchTestStore,
  evidenceBundle,
  seedMappedCheck,
  SYNCED_AT,
} from "./test-helpers.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("bench results repository", () => {
  it("keeps mapped and unmapped checks visible but proof columns fail closed", () => {
    const fixture = createBenchTestStore("results-mapping");
    hosts.push(fixture.host);
    seedMappedCheck(fixture.db);
    storeEvidenceCheckpointWithResult(
      fixture.db,
      evidenceBundle({
        results: [
          { requirementId: "REQ-A", checkId: "check-a", outcome: "pass", evidenceSummary: "ok" },
          {
            requirementId: "REQ-UNMAPPED",
            checkId: "unknown-check",
            outcome: "fail",
            evidenceSummary: "visible failure",
          },
        ],
      }),
      SYNCED_AT,
    );
    const page = listBenchResults(fixture.db, {
      projectId: "project-a",
      pvId: "version-a",
      runId: "run-a",
      pageSize: 20,
      continuation: null,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirementId: "REQ-A",
          checkId: "check-a",
          mapped: true,
          outcome: "pass",
        }),
        expect.objectContaining({
          requirementId: null,
          checkId: null,
          reportedRequirementId: "REQ-UNMAPPED",
          reportedCheckId: "unknown-check",
          mapped: false,
          outcome: "fail",
        }),
      ]),
    );
  });

  it("makes duplicate checkpoints idempotent", () => {
    const fixture = createBenchTestStore("results-idempotent");
    hosts.push(fixture.host);
    seedMappedCheck(fixture.db);
    const bundle = evidenceBundle({
      results: [
        { requirementId: "REQ-A", checkId: "check-a", outcome: "pass", evidenceSummary: null },
      ],
    });
    expect(storeEvidenceCheckpointWithResult(fixture.db, bundle, SYNCED_AT).changed).toBe(true);
    expect(storeEvidenceCheckpointWithResult(fixture.db, bundle, SYNCED_AT).changed).toBe(false);
    expect(fixture.db.prepare("SELECT COUNT(*) FROM verification_results").pluck().get()).toBe(1);
  });

  it("rolls back the entire checkpoint when one result is invalid", () => {
    const fixture = createBenchTestStore("results-rollback");
    hosts.push(fixture.host);
    seedMappedCheck(fixture.db);
    expect(() =>
      storeEvidenceCheckpointWithResult(
        fixture.db,
        evidenceBundle({
          results: [
            { requirementId: "REQ-A", checkId: "check-a", outcome: "pass", evidenceSummary: null },
            {
              requirementId: "REQ-A",
              checkId: "check-a",
              outcome: "error",
              evidenceSummary: "x".repeat(20_001),
            },
          ],
        }),
        SYNCED_AT,
      ),
    ).toThrow(/too large/iu);
    expect(fixture.db.prepare("SELECT COUNT(*) FROM verification_runs").pluck().get()).toBe(0);
    expect(fixture.db.prepare("SELECT COUNT(*) FROM verification_results").pluck().get()).toBe(0);
  });
});
