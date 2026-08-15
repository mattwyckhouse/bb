import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";

import { rpcContract } from "../../../shared/contract.js";
import { findingsCacheState } from "../cache/query.js";
import { applyPolicy, PolicyApplyError } from "./apply.js";
import type { PolicyReport, PolicyRuleReport } from "./report.js";

const policyRpcContract = {
  triagePolicyPreview: rpcContract.triagePolicyPreview,
  triagePolicyApply: rpcContract.triagePolicyApply,
} as const;

// Preview reuse is intentionally process-local and bounded; apply must follow
// preview within the same plugin lifetime before this small cache evicts it.
const MAX_REUSABLE_PREVIEWS = 4;

interface ResolvedPolicyScope {
  root: string;
  platformProjectId: string;
  projectVersionId: string;
}

interface StoredPreview extends ResolvedPolicyScope {
  workspaceProjectId: string;
  report: PolicyReport;
}

interface PolicyPageInput {
  projectId: string;
  projectVersionId: string | null;
  pageSize: number;
  continuation: string | null;
}

function heldCount(rules: readonly PolicyRuleReport[]): number {
  return rules.reduce((total, rule) => total + rule.held, 0);
}

function policyReportItem(
  projectId: string,
  projectVersionId: string,
  report: PolicyReport,
) {
  return {
    projectId,
    projectVersionId,
    kind: "triagePolicyRun",
    key: report.runId,
    label: report.dryRun ? "Policy preview" : "Policy application",
    fields: {
      policySha256: report.policySha256,
      dryRun: report.dryRun,
      wouldWrite: report.rules.reduce(
        (total, rule) => total + rule.wouldWrite,
        0,
      ),
      skippedExisting: report.skippedExisting,
      rules: report.rules.map((rule) => ({
        name: rule.name,
        matched: rule.matched,
        wouldWrite: rule.wouldWrite,
        held: rule.held,
        samples: [...rule.samples],
      })),
      held: report.held.map((item) => ({
        stableKey: item.stableKey,
        rule: item.rule,
        why: item.why,
      })),
      errors: report.errors.map((error) => ({
        stableKey: error.stableKey ?? null,
        code: error.code,
        message: error.message,
      })),
    },
  };
}

function policyReportPage(
  db: Database.Database,
  input: PolicyPageInput,
  scope: ResolvedPolicyScope,
  report: PolicyReport,
  errorCount = report.errors.length,
) {
  if (input.continuation !== null) {
    throw new Error(
      "POLICY_CONTINUATION_INVALID: policy reports are returned as one bounded summary item",
    );
  }
  return {
    projectId: input.projectId,
    projectVersionId: scope.projectVersionId,
    runId: report.runId,
    items: [
      policyReportItem(input.projectId, scope.projectVersionId, report),
    ].slice(0, input.pageSize),
    total: 1,
    next: null,
    written: report.written,
    held: heldCount(report.rules),
    errors: errorCount,
    cache: findingsCacheState(
      db,
      scope.platformProjectId,
      scope.projectVersionId,
    ),
  };
}

function rememberPreview(
  previews: Map<string, StoredPreview>,
  preview: StoredPreview,
): void {
  previews.set(preview.report.runId, preview);
  while (previews.size > MAX_REUSABLE_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) return;
    previews.delete(oldest);
  }
}

function reusablePreview(
  previews: Map<string, StoredPreview>,
  runId: string,
): StoredPreview {
  const preview = previews.get(runId);
  if (!preview) {
    throw new Error(
      "POLICY_PREVIEW_REQUIRED: the exact in-memory evaluation is unavailable; preview again before applying",
    );
  }
  previews.delete(runId);
  previews.set(runId, preview);
  return preview;
}

function assertPolicyRunNotApplied(
  db: Database.Database,
  scope: ResolvedPolicyScope,
  runId: string,
): void {
  const existing = db
    .prepare<[string, string, string], { run_id: string }>(
      `SELECT run_id
         FROM triage_runs
        WHERE project_id = ? AND project_version_id = ? AND run_id = ?
        LIMIT 1`,
    )
    .get(scope.platformProjectId, scope.projectVersionId, runId);
  if (existing !== undefined) {
    throw new PolicyApplyError(
      "POLICY_ALREADY_APPLIED",
      "POLICY_ALREADY_APPLIED: policy run id is already recorded; preview again before applying",
    );
  }
}

export function registerFindingsPolicy(
  bb: BbPluginApi,
  db: Database.Database,
  resolveScope: (input: {
    projectId: string;
    projectVersionId: string | null;
  }) => Promise<ResolvedPolicyScope>,
): void {
  const previews = new Map<string, StoredPreview>();
  bb.onDispose(() => previews.clear());
  bb.rpc.register(policyRpcContract, {
    async triagePolicyPreview(input) {
      const scope = await resolveScope(input);
      const report = await applyPolicy(
        { db, root: scope.root },
        {
          projectId: scope.platformProjectId,
          projectVersionId: scope.projectVersionId,
          project: scope.platformProjectId,
        },
        { dryRun: true },
      );
      rememberPreview(previews, {
        ...scope,
        workspaceProjectId: input.projectId,
        report,
      });
      return policyReportPage(db, input, scope, report);
    },
    async triagePolicyApply(input) {
      // The frozen paged input helper erases its extra-field types, but bb has
      // already validated both fields against the exact RPC schema here.
      const extended = input as typeof input & {
        runId: string;
        expectedPolicySha256: string;
      };
      const preview = reusablePreview(previews, extended.runId);
      const scope = await resolveScope(input);
      if (
        preview.workspaceProjectId !== input.projectId ||
        preview.platformProjectId !== scope.platformProjectId ||
        preview.projectVersionId !== scope.projectVersionId ||
        preview.root !== scope.root
      ) {
        throw new Error(
          "POLICY_PREVIEW_SCOPE_MISMATCH: preview and apply must use the same workspace and accepted finding scope",
        );
      }
      assertPolicyRunNotApplied(db, scope, extended.runId);
      const report = await applyPolicy(
        { db, root: scope.root },
        {
          projectId: scope.platformProjectId,
          projectVersionId: scope.projectVersionId,
          project: scope.platformProjectId,
        },
        {
          dryRun: false,
          expectedPolicySha256: extended.expectedPolicySha256,
          evaluated: preview.report,
        },
      );
      const candidateCount = preview.report.rules.reduce(
        (total, rule) => total + rule.wouldWrite,
        0,
      );
      const skippedDuringApply =
        report.skippedExisting - preview.report.skippedExisting;
      const errorCount = Math.max(
        0,
        candidateCount - report.written - skippedDuringApply,
      );
      return policyReportPage(db, input, scope, report, errorCount);
    },
  });
}
