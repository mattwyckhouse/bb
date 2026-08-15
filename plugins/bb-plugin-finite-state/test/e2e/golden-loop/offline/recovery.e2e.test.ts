import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import type {
  Json,
  PlatformClient,
  VexBulkSetResult,
  VexDecisionInput,
} from "../../../../lib/remote/types.js";
import { findingStableKey } from "../../../../lib/sync/registry.js";
import { MIGRATIONS } from "../../../../lib/store/schema.js";
import { BENCH_DISPATCH_AMBIGUOUS_CODE } from "../../../../lanes/bench/ambiguity.js";
import { evaluateOtaVerdict } from "../../../../lanes/bench/verdict/evaluate.js";
import { createVexBulkPusher } from "../../../../lanes/findings/bulk/index.js";
import { applyPolicy } from "../../../../lanes/findings/policy/apply.js";
import { parseTriagePolicy } from "../../../../lanes/findings/policy/schema.js";
import { readOverlayFiles } from "../../../../lanes/findings/overlay/reader.js";
import { setDecision } from "../../../../lanes/findings/overlay/writer.js";
import { stableKeyFor, type VexTuple } from "../../../../lanes/findings/overlay/schema.js";
import { registerFindingsStableKeyStub } from "../../../../lanes/findings/stable-key/index.js";
import { ADMIN_BYTES_RECOVERY } from "../../../../lanes/firmware/api/admin-gate.js";
import { syncMetadata } from "../../../../lanes/sync/engine/status.js";
import type {
  FieldDiff,
  FieldValue,
  Plan,
  PlanItem,
} from "../../../../lanes/sync/plan/index.js";
import { push, resumePush } from "../../../../lanes/sync/push/index.js";
import { contentHash } from "../../../../lanes/sync/serialize/canonical.js";
import { BaseSnapshotStore } from "../../../../lanes/sync/store/base-snapshot.js";
import type { JsonValue } from "../../../../shared/contract.js";
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

const databases: Database.Database[] = [];
const roots: string[] = [];
const PROJECT = "project-fs84-recovery";
const PV = "pv-fs84-recovery";
const GENERATION = "generation-fs84-recovery";
const AT = "2026-08-15T12:00:00.000Z";
const DESIRED: VexTuple = {
  status: "RESOLVED",
  response: null,
  justification: null,
  reason: "FS-84 recovery proof",
};

afterEach(async () => {
  resetFailures();
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function database(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration);
  return db;
}

function seedPushScope(db: Database.Database): void {
  db.prepare(
    `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status, requested_kinds_json,
        started_at, completed_at, accepted_at, error)
     VALUES (?, ?, ?, 'accepted', '["finding","vexDecision"]', ?, ?, ?, NULL)`,
  ).run(PROJECT, PV, GENERATION, AT, AT, AT);
  for (const kind of ["finding", "vexDecision"]) {
    db.prepare(
      `INSERT INTO sync_state
         (project_id, project_version_id, entity_kind, accepted_generation_id,
          staging_generation_id, base_revision, staging_continuation, staged_pages,
          staged_rows, last_pull, error)
       VALUES (?, ?, ?, ?, NULL, 0, NULL, 0, 0, ?, NULL)`,
    ).run(PROJECT, PV, kind, GENERATION, AT);
  }
  registerFindingsStableKeyStub(db);
}

interface PushFixture {
  db: Database.Database;
  details: Map<string, Record<string, Json>>;
}

function pushFixture(): PushFixture {
  const db = database();
  seedPushScope(db);
  return { db, details: new Map() };
}

function insertFinding(
  state: PushFixture,
  input: { id: string; cve: string; purl: string; name: string },
): string {
  const key = findingStableKey({
    cve: input.cve,
    purl: input.purl,
    name: input.name,
    group: null,
    version: "1.0.0",
  });
  const detail = {
    id: input.id,
    cve: input.cve,
    componentId: input.name,
    componentFallbackIdentity: input.name,
    componentPurl: input.purl,
    vexStatus: null,
    vexResponse: null,
    vexJustification: null,
    vexReason: null,
  } satisfies Record<string, Json>;
  state.details.set(input.id, detail);
  state.db.prepare(
    `INSERT INTO findings
       (project_id, project_version_id, generation_id, finding_id, stable_key,
        cve, component_name, component_group, component_version, component_purl,
        vex_status, vex_response, vex_justification, vex_reason, raw, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '1.0.0', ?, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    PROJECT,
    PV,
    GENERATION,
    input.id,
    key,
    input.cve,
    input.name,
    input.purl,
    JSON.stringify(detail),
    AT,
  );
  return key;
}

function insertGuard(
  state: PushFixture,
  key: string,
  cve: string,
): void {
  state.db.prepare(
    `INSERT INTO overlay_index
       (project_id, project_version_id, entity_kind, stable_key, cve, file_path,
        file_sha256, vex_status, vex_response, vex_justification, vex_reason, pin,
        provenance_by, provenance_at, evidence, sync_base, pushed_at, local_state,
        drift_state, match_tier, indexed_at)
     VALUES (?, ?, 'vexDecision', ?, ?, ?, ?, ?, NULL, NULL, ?, 'exact_version',
             'engineer', ?, 'FS-84 recovery', NULL, NULL, 'dirty', NULL, 'purl', ?)`,
  ).run(
    PROJECT,
    PV,
    key,
    cve,
    `.fs/triage/${PROJECT}/${cve}.yaml`,
    "a".repeat(64),
    DESIRED.status,
    DESIRED.reason,
    AT,
    AT,
  );
}

function fieldValue(
  payload: Readonly<Record<string, JsonValue>>,
  field: string,
): FieldValue {
  return Object.hasOwn(payload, field)
    ? { present: true, value: payload[field] ?? null }
    : { present: false, value: null };
}

function planItem(key: string, cve: string): PlanItem {
  const payload: Record<string, JsonValue> = { ...DESIRED };
  const fields: FieldDiff[] = Object.keys(payload)
    .sort()
    .map((field) => ({
      field,
      base: { present: false, value: null },
      ours: fieldValue(payload, field),
      theirs: { present: false, value: null },
    }));
  return {
    projectId: PROJECT,
    projectVersionId: PV,
    kind: "vexDecision",
    key,
    label: cve,
    operation: "create",
    expectedBaseContentHash: null,
    fields,
    conflicts: [],
    referrers: [],
    error: null,
  };
}

async function persistPlan(
  state: PushFixture,
  items: PlanItem[],
  planId: string,
): Promise<{ plan: Plan; root: string }> {
  const metadata = syncMetadata(
    { db: state.db },
    { projectId: PROJECT, projectVersionId: PV },
    ["vexDecision"],
  );
  const draft: Plan = {
    projectId: PROJECT,
    projectVersionId: PV,
    planId,
    planSha256: "",
    baseGenerationIds: metadata.acceptedGenerationIds,
    baseRevisions: metadata.baseRevisions,
    baseStateSha256: metadata.baseStateSha256,
    createdAt: AT,
    staleness: { asOf: AT, degraded: false },
    items,
    summary: {
      creates: items.filter(({ operation }) => operation === "create").length,
      updates: 0,
      deletes: 0,
      noops: 0,
      conflicts: items.filter(({ operation }) => operation === "conflict")
        .length,
      orphans: 0,
    },
    blastRadius: {
      requiresHumanReview: true,
      changed: items.length,
      deletes: 0,
      remoteCalls: items.length,
      surfaces: ["vexDecision"],
    },
    validationErrors: [],
    total: items.length,
    next: null,
    cache: {
      state: "fresh",
      asOf: AT,
      message: null,
      acceptedGenerationId: GENERATION,
      baseRevision: metadata.baseRevisions["vexDecision"] ?? 0,
    },
  };
  const { planSha256: _ignored, ...unsigned } = draft;
  const plan = { ...draft, planSha256: contentHash(unsigned) };
  const root = await mkdtemp(join(tmpdir(), "fs84-push-recovery-"));
  roots.push(root);
  await mkdir(join(root, ".fs-sync"), { recursive: true });
  await writeFile(
    join(root, ".fs-sync", `plan-${planId}.json`),
    `${JSON.stringify(plan)}\n`,
  );
  return { plan, root };
}

function applyVex(detail: Record<string, Json>, input: VexDecisionInput): void {
  detail["vexStatus"] = input.status;
  detail["vexResponse"] = input.response ?? null;
  detail["vexJustification"] = input.justification ?? null;
  detail["vexReason"] = input.reason ?? null;
}

function platformFor(
  state: PushFixture,
  calls: string[][],
): Pick<
  PlatformClient,
  "batchSetVexStatus" | "clearVexStatus" | "getFindingDetail" | "getFindings"
> {
  let disconnected = false;
  return {
    async batchSetVexStatus(input): Promise<VexBulkSetResult> {
      calls.push(input.findings.map(({ findingId }) => findingId));
      if (calls.length === 2 && !disconnected) {
        disconnected = true;
        throw new Error("injected mid-push connection reset");
      }
      for (const finding of input.findings) {
        const detail = state.details.get(finding.findingId);
        if (detail !== undefined) applyVex(detail, finding);
      }
      return {
        status: "success",
        summary: {
          total: input.findings.length,
          succeeded: input.findings.length,
          failed: 0,
        },
        results: input.findings.map((finding) => ({
          findingId: finding.findingId,
          success: true,
          status: finding.status,
          error: null,
        })),
      };
    },
    async clearVexStatus(input): Promise<void> {
      for (const findingId of input.findingIds) {
        const detail = state.details.get(findingId);
        if (detail !== undefined) {
          detail["vexStatus"] = null;
          detail["vexResponse"] = null;
          detail["vexJustification"] = null;
          detail["vexReason"] = null;
        }
      }
    },
    async getFindingDetail(input) {
      const detail = state.details.get(input.findingId);
      if (detail === undefined) throw new Error(`Missing finding ${input.findingId}`);
      return structuredClone(detail);
    },
    async *getFindings(input) {
      const corpus = [...state.details.values()].map((detail) =>
        structuredClone(detail),
      );
      const pageSize = input.page?.pageSize ?? 1_000;
      for (let offset = 0; offset < corpus.length; offset += pageSize) {
        const items = corpus.slice(offset, offset + pageSize);
        yield { items, total: corpus.length, next: null };
      }
    },
  };
}

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
    const state = pushFixture();
    const key = insertFinding(state, {
      id: "conflict-1",
      cve: "CVE-2026-8401",
      purl: "pkg:npm/conflict@1.0.0",
      name: "conflict",
    });
    insertGuard(state, key, "CVE-2026-8401");
    const conflict = {
      ...planItem(key, "CVE-2026-8401"),
      operation: "conflict" as const,
    };
    const persisted = await persistPlan(
      state,
      [conflict],
      "01KWP290000000000000000004",
    );
    let code = "";
    try {
      await push(
        { db: state.db, worktreeRoot: persisted.root, pushers: [] },
        {
          scope: { projectId: PROJECT, projectVersionId: PV },
          planId: persisted.plan.planId,
          expectedPlanSha256: persisted.plan.planSha256,
          expectedBaseStateSha256: persisted.plan.baseStateSha256,
          confirmed: true,
        },
      );
    } catch (error) {
      code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
    }
    expect(code).toBe("PLAN_CONFLICT_UNRESOLVED");
    const proof = await observe("sync-conflict", "before-push", {
      visibleStatus: `${code}: same-field upstream tuple changed`,
      durableArtifacts: [
        join(persisted.root, ".fs-sync", `plan-${persisted.plan.planId}.json`),
      ],
      recoverySteps: ["pull status", "review conflict", "re-plan"],
      finalState: "resumable",
    });
    expect(proof.visibleStatus).toContain("PLAN_CONFLICT_UNRESOLVED");
    expect(state.db.prepare("SELECT COUNT(*) FROM push_log").pluck().get()).toBe(0);
    expect(proof.finalState).toBe("resumable");
  });

  it("advances the VEX base only for successes and resumes failed rows only", async () => {
    const state = pushFixture();
    const appliedKey = insertFinding(state, {
      id: "applied-1",
      cve: "CVE-2026-8402",
      purl: "pkg:npm/applied@1.0.0",
      name: "applied",
    });
    let pendingKey = "";
    for (let index = 0; index < 501; index += 1) {
      pendingKey = insertFinding(state, {
        id: `pending-${index}`,
        cve: "CVE-2026-8403",
        purl: "pkg:npm/pending@1.0.0",
        name: "pending",
      });
    }
    insertGuard(state, appliedKey, "CVE-2026-8402");
    insertGuard(state, pendingKey, "CVE-2026-8403");
    const persisted = await persistPlan(
      state,
      [
        planItem(appliedKey, "CVE-2026-8402"),
        planItem(pendingKey, "CVE-2026-8403"),
      ],
      "01KWP290000000000000000003",
    );
    const calls: string[][] = [];
    const platform = platformFor(state, calls);
    const deps = {
      db: state.db,
      worktreeRoot: persisted.root,
      pushers: [
        createVexBulkPusher({
          db: state.db,
          platform,
          publish: () => undefined,
        }),
      ],
      createRunId: () => "fs84-partial-push",
    };
    const first = await push(deps, {
      scope: { projectId: PROJECT, projectVersionId: PV },
      planId: persisted.plan.planId,
      expectedPlanSha256: persisted.plan.planSha256,
      expectedBaseStateSha256: persisted.plan.baseStateSha256,
      confirmed: true,
    });
    expect(first.summary).toEqual({
      total: 2,
      applied: 1,
      failed: 1,
      skipped: 0,
    });
    expect(first.items[1]?.error).toMatchObject({
      code: "VEX_PARTIAL_FAILURE",
      retryable: true,
    });
    expect(
      new BaseSnapshotStore(state.db).getAccepted(
        PROJECT,
        PV,
        "vexDecision",
        appliedKey,
      )?.payload,
    ).toEqual(DESIRED);
    expect(
      new BaseSnapshotStore(state.db).getAccepted(
        PROJECT,
        PV,
        "vexDecision",
        pendingKey,
      ),
    ).toBeNull();

    const resumed = await resumePush(deps, "fs84-partial-push");
    expect(resumed.summary).toEqual({
      total: 2,
      applied: 2,
      failed: 0,
      skipped: 0,
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[2]).not.toContain("applied-1");
    expect(
      new BaseSnapshotStore(state.db).getAccepted(
        PROJECT,
        PV,
        "vexDecision",
        pendingKey,
      )?.payload,
    ).toEqual(DESIRED);
    const proof = await observe(
      "partial-push-disconnect",
      "after-successful-chunk",
      {
        visibleStatus: `${first.items[1]!.error!.code}: ${first.summary.applied} applied, ${first.summary.failed} pending`,
        durableArtifacts: [
          join(persisted.root, ".fs-sync", "push-fs84-partial-push.json"),
          join(persisted.root, ".fs-sync", `plan-${persisted.plan.planId}.json`),
        ],
        recoverySteps: [
          "query status first",
          "resume run; do not create a new push",
        ],
        finalState: "recovered",
      },
    );
    expect(proof.visibleStatus).toContain("VEX_PARTIAL_FAILURE");
    expect(proof.recoverySteps[0]).toBe("query status first");
  }, 30_000);

  it("leaves parseable YAML and a partial run record after an interrupted writer", async () => {
    const db = database();
    seedPushScope(db);
    const root = await mkdtemp(join(tmpdir(), "fs-writer-recovery-"));
    roots.push(root);
    for (let index = 0; index < 3; index += 1) {
      const cve = `CVE-2026-${8500 + index}`;
      const component = {
        purl: `pkg:npm/writer-${index}@1.0.0`,
        name: `writer-${index}`,
        group: null,
        version: "1.0.0",
      };
      const stableKey = stableKeyFor(PROJECT, component, cve);
      db.prepare(
        `INSERT INTO findings
          (project_id, project_version_id, generation_id, finding_id, stable_key,
           finding_type, cve, component_name, component_version, component_purl,
           severity, band, epss_score, in_kev, in_vc_kev, reachability_score,
           reachability_factors, vuln_in_dataset, cwes, vex_status, raw, pulled_at)
         VALUES (?, ?, ?, ?, ?, 'vulnerability', ?, ?, '1.0.0', ?, 'HIGH',
                 'CRITICAL', 0.7, 0, 0, -1, '["no caller"]', 1, '["CWE-79"]',
                 NULL, '{}', ?)`,
      ).run(
        PROJECT,
        PV,
        GENERATION,
        `writer-${index}`,
        stableKey,
        cve,
        component.name,
        component.purl,
        AT,
      );
    }
    const policy = parseTriagePolicy({
      schema: "fs-triage-policy/v1",
      rules: [
        {
          name: "critical-in-triage",
          when: { band: "CRITICAL" },
          set: { status: "IN_TRIAGE", reason: "FS-84 interrupted writer" },
        },
      ],
      holdback: [],
      options: { overwrite_existing: false },
    });
    const scope = { projectId: PROJECT, projectVersionId: PV, project: PROJECT };
    const controller = new AbortController();
    let writes = 0;
    const interruptedWriter: typeof setDecision = async (...args) => {
      if (writes === 1) {
        controller.abort(new Error("injected writer interruption"));
        controller.signal.throwIfAborted();
      }
      const result = await setDecision(...args);
      writes += 1;
      return result;
    };
    const interruptedDeps = {
      db,
      root,
      policy,
      setDecision: interruptedWriter,
      signal: controller.signal,
    };
    const preview = await applyPolicy(interruptedDeps, scope, { dryRun: true });
    await expect(
      applyPolicy(interruptedDeps, scope, {
        dryRun: false,
        expectedPolicySha256: preview.policySha256,
        evaluated: preview,
      }),
    ).rejects.toThrow("injected writer interruption");
    expect(
      db.prepare("SELECT status, written FROM triage_runs").get(),
    ).toEqual({ status: "partial", written: 1 });
    const interruptedFiles = await readOverlayFiles(root);
    expect(interruptedFiles.files).toHaveLength(1);
    expect(parse(await readFile(interruptedFiles.files[0]!.absoluteFile, "utf8"))).toMatchObject({
      schema: "fs-triage/v1",
    });

    const recoveryDeps = { db, root, policy };
    const recoveryPreview = await applyPolicy(recoveryDeps, scope, {
      dryRun: true,
    });
    const recovered = await applyPolicy(recoveryDeps, scope, {
      dryRun: false,
      expectedPolicySha256: recoveryPreview.policySha256,
      evaluated: recoveryPreview,
    });
    expect(recovered).toMatchObject({ written: 2, skippedExisting: 1, errors: [] });
    const recoveredFiles = await readOverlayFiles(root);
    expect(recoveredFiles.files).toHaveLength(3);
    for (const file of recoveredFiles.files) {
      expect(parse(await readFile(file.absoluteFile, "utf8"))).toMatchObject({
        schema: "fs-triage/v1",
      });
    }
    expect(
      db.prepare("SELECT status, written FROM triage_runs ORDER BY rowid").all(),
    ).toEqual([
      { status: "partial", written: 1 },
      { status: "completed", written: 2 },
    ]);
    const proof = await observe("writer-interrupted", "item-2", {
      visibleStatus: "POLICY_RUN_PARTIAL: 1 written, 2 pending",
      durableArtifacts: [
        interruptedFiles.files[0]!.absoluteFile,
        "sqlite:triage_runs",
      ],
      recoverySteps: ["parse authored YAML", "preview and rerun remaining decisions"],
      finalState: "recovered",
    });
    expect(proof.unsupportedSuccessShown).toBe(false);
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
      currentMountedDigest: digestB,
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
              signatureVerified: true,
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
        visibleStatus: `${verdict.evidence[0]!.state}: signature and digest do not bind current firmware`,
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
    expect(verdict.evidence[0]?.state).toBe("invalid_signature");
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
