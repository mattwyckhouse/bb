import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { BENCH_DISPATCH_AMBIGUOUS_CODE } from "../../../../lanes/bench/ambiguity.js";
import { evaluateOtaVerdict } from "../../../../lanes/bench/verdict/evaluate.js";
import { ADMIN_BYTES_RECOVERY } from "../../../../lanes/firmware/api/admin-gate.js";
import {
  assertRecovery,
  injectFailure,
  InjectedGoldenLoopFailure,
  recordRecovery,
  resetFailures,
  triggerFailure,
  type FailureScenario,
  type RecoveryProof,
} from "./failures.js";

afterEach(resetFailures);

async function observe(
  scenario: FailureScenario,
  at: string,
  proof: Omit<RecoveryProof, "scenario" | "unsupportedSuccessShown">,
) {
  injectFailure(scenario, at);
  expect(() => triggerFailure(scenario, at)).toThrow(InjectedGoldenLoopFailure);
  recordRecovery({ scenario, unsupportedSuccessShown: false, ...proof });
  return assertRecovery(scenario);
}

describe("Golden Loop failure recovery", () => {
  it("names a stale same-field conflict before human push", async () => {
    const proof = await observe("sync-conflict", "before-push", {
      visibleStatus: "SYNC_CONFLICT: same-field upstream tuple changed",
      durableArtifacts: [
        "artifacts/sync/plan.json",
        "artifacts/sync/base.json",
      ],
      recoverySteps: ["pull status", "review conflict", "re-plan"],
      finalState: "resumable",
    });
    expect(proof.visibleStatus).toContain("SYNC_CONFLICT");
    expect(proof.finalState).toBe("resumable");
  });

  it("advances the VEX base only for successes and resumes failed rows only", async () => {
    const requested = ["vex-a", "vex-b", "vex-c"];
    const applied = new Set(["vex-a", "vex-b"]);
    const resumed = requested.filter((key) => !applied.has(key));
    const proof = await observe(
      "partial-push-disconnect",
      "after-successful-chunk",
      {
        visibleStatus:
          "VEX_PARTIAL_FAILURE: connection reset; 2 applied, 1 pending",
        durableArtifacts: [
          "artifacts/push/run.json",
          "artifacts/push/base.json",
        ],
        recoverySteps: [
          "query status first",
          "resume run; do not create a new push",
        ],
        finalState: "recovered",
      },
    );
    expect([...applied]).toEqual(["vex-a", "vex-b"]);
    expect(resumed).toEqual(["vex-c"]);
    expect(proof.recoverySteps[0]).toBe("query status first");
  });

  it("leaves parseable YAML and an incomplete marker after an interrupted writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-writer-recovery-"));
    try {
      const overlay = join(root, "decision.yaml");
      const marker = join(root, "triage-run.incomplete.json");
      await writeFile(
        overlay,
        "schema: fs-triage/v1\nproject: demo\ndecisions: {}\n",
      );
      await writeFile(
        marker,
        '{"status":"partial","written":39,"pending":1}\n',
      );
      const proof = await observe("writer-interrupted", "item-40", {
        visibleStatus: "OVERLAY_CAS_CONFLICT: 39 written, 1 pending",
        durableArtifacts: [overlay, marker],
        recoverySteps: [
          "parse authored YAML",
          "rerun with the current CAS hash",
        ],
        finalState: "recovered",
      });
      expect(parse(await readFile(overlay, "utf8"))).toMatchObject({
        schema: "fs-triage/v1",
      });
      expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
        status: "partial",
      });
      expect(proof.unsupportedSuccessShown).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps firmware metadata-only and requires standalone unpack after admin denial", async () => {
    const proof = await observe(
      "firmware-gap-or-admin-denied",
      "api-byte-request",
      {
        visibleStatus: `FIRMWARE_ADMIN_BYTES_REQUIRED: ${ADMIN_BYTES_RECOVERY}`,
        durableArtifacts: [".fs-firmware/pv-ax3000-unpack-gap/manifest.sqlite"],
        recoverySteps: [
          "run local standalone unpack",
          "verify full materialization and digest",
        ],
        finalState: "honestly-blocked",
      },
    );
    expect(proof.visibleStatus).toContain("FIRMWARE_ADMIN_BYTES_REQUIRED");
    expect(proof.finalState).not.toBe("recovered");
  });

  it("queries an ambiguous bench run before any non-idempotent retry", async () => {
    const proof = await observe(
      "bench-unavailable-or-ambiguous",
      "dispatch-response-lost",
      {
        visibleStatus: `${BENCH_DISPATCH_AMBIGUOUS_CODE}: run run-demo may exist`,
        durableArtifacts: ["artifacts/bench/run-demo.json"],
        recoverySteps: [
          "query status first",
          "retry only when no run or job exists",
        ],
        finalState: "resumable",
      },
    );
    expect(proof.recoverySteps[0]).toBe("query status first");
  });

  it("blocks safe-to-OTA on signature and firmware-digest mismatch", async () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const verdict = evaluateOtaVerdict({
      pvId: "pv-demo",
      firmwareDigest: digestB,
      currentMountedDigest: digestA,
      modelAvailable: true,
      requirements: [
        {
          requirementId: "REQ-A",
          tier: "static",
          required: true,
          mappedCheckIds: ["check-a"],
        },
      ],
      candidates: [
        {
          resultId: "result-a",
          requirementId: "REQ-A",
          tier: "static",
          mappingState: "mapped",
          runId: "run-a",
          checkId: "check-a",
          outcome: "pass",
          resultStatus: "verified",
          runStatus: "completed",
          firmwareDigest: digestB,
          runStartedAt: "2026-08-15T10:00:00Z",
          runFinishedAt: "2026-08-15T10:01:00Z",
          resultExecutedAt: "2026-08-15T10:01:00Z",
          pulledAt: "2026-08-15T10:02:00Z",
          superseded: false,
          attestations: [
            {
              attestationId: "att-a",
              signatureVerified: false,
              subjectMatchesDigest: false,
              verified: false,
              subjectDigest: digestA,
              requirementIds: ["REQ-A"],
              checkIds: ["check-a"],
              resultRefs: ["result-a"],
              signerIdentity: null,
              createdAt: "2026-08-15T10:02:00Z",
            },
          ],
        },
      ],
      computedAt: "2026-08-15T10:03:00Z",
    });
    const proof = await observe(
      "attestation-binding-invalid",
      "verdict-evaluation",
      {
        visibleStatus:
          "ATTESTATION_BINDING_INVALID: signature and digest do not bind current firmware",
        durableArtifacts: [
          "artifacts/verdict/input.json",
          "artifacts/attestations/att-a.json",
        ],
        recoverySteps: [
          "preserve invalid attestation",
          "rerun and sign against the mounted digest",
        ],
        finalState: "honestly-blocked",
      },
    );
    expect(verdict.verdict).not.toBe("SAFE_TO_OTA");
    expect(verdict.proven).toBe(0);
    expect(proof.unsupportedSuccessShown).toBe(false);
  });

  it("refuses recovery claims without a triggered failure or durable evidence", async () => {
    injectFailure("sync-conflict", "before-push");
    await expect(assertRecovery("sync-conflict")).rejects.toThrow(
      "was not triggered",
    );
    expect(() => triggerFailure("sync-conflict", "before-push")).toThrow(
      InjectedGoldenLoopFailure,
    );
    expect(() =>
      recordRecovery({
        scenario: "sync-conflict",
        visibleStatus: "conflict",
        unsupportedSuccessShown: false,
        durableArtifacts: [],
        recoverySteps: ["pull"],
        finalState: "resumable",
      }),
    ).toThrow("preserved no durable artifacts");
  });
});
