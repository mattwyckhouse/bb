import type { BbPluginApi, PluginAgentToolContext } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { PluginContext } from "../../../lib/context.js";
import {
  KnownToolError,
  executeSafely,
  ok,
  writeResult,
} from "../../../lib/agentic/result.js";
import type {
  FieldDiff,
  ToolError,
  ToolResult,
} from "../../../lib/agentic/types.js";
import { resolveProjectWorktreeRoot } from "../../documents/store.js";
import {
  applyHbomExtraction,
  type ExtractionResult,
} from "../../bom/hbom/extract.js";
import { HBOM_CHANGED_CHANNEL } from "../../bom/hbom/types.js";
import { HbomStaleError } from "../../bom/hbom/yaml.js";
import { acceptedPlatformProjectId } from "../../findings/rpc.js";
import { applyPolicy, PolicyApplyError } from "../../findings/policy/apply.js";
import { rebuildOverlayIndex } from "../../findings/overlay/indexer.js";
import {
  OverlayCasConflictError,
  setDecision,
  type OverlayWriteResult,
} from "../../findings/overlay/writer.js";
import { FindingPinError } from "../../findings/stable-key/resolve.js";
import type { DecisionInput } from "../../findings/overlay/schema.js";
import { createSdkRequirementRepository } from "../../product-security/requirements/cards/adapter.js";
import { validateRequirement } from "../../product-security/requirements/cards/validator.js";
import {
  hbomExtractSchema,
  requirementWriteSchema,
  triageApplyPolicySchema,
  triageSetSchema,
  type HbomExtractInput,
  type RequirementWriteInput,
  type TriageApplyPolicyInput,
  type TriageSetInput,
} from "./write-schemas.js";

export const TRIAGE_WRITER_SERVICE = "agentic.write.triage" as const;
export const REQUIREMENT_WRITER_SERVICE = "agentic.write.requirement" as const;
export const HBOM_EXTRACTOR_SERVICE = "agentic.write.hbom" as const;

export type LocalWrite = {
  path: string;
  op: "create" | "update" | "noop";
  diffSummary: Array<{ field: string; from: string | null; to: string | null }>;
  contentHash: string;
  omittedDiffs: number;
};

export interface TriageWriter {
  set(
    input: TriageSetInput,
    scope: { projectId: string; signal: AbortSignal },
  ): Promise<LocalWrite>;
  applyPolicy(
    input: TriageApplyPolicyInput,
    scope: { projectId: string; signal: AbortSignal },
  ): Promise<{
    paths: string[];
    written: number;
    held: Array<{ key: string; rule: string; why: string }>;
    skippedExisting: number;
    errors: ToolError[];
    runId: string;
    dryRun: boolean;
    policySha256: string;
  }>;
}

export interface RequirementWriter {
  write(
    input: RequirementWriteInput,
    scope: { projectId: string; signal: AbortSignal },
  ): Promise<
    LocalWrite & {
      gates: {
        schema: "passed";
        lint: "passed";
        humanReview: "pending";
      };
    }
  >;
}

export interface HbomExtractor {
  merge(
    input: HbomExtractInput,
    scope: { projectId: string; signal: AbortSignal },
  ): Promise<{
    path: string;
    merged: number;
    queued: number;
    conflicts: number;
    candidatesAdded: number;
    contentHash: string;
    diffSummary: string;
    rejected: Array<{ cell: string; error: ToolError }>;
  }>;
}

interface FindingIdentityRow {
  project_id: string;
  cve: string;
  component_name: string;
  component_group: string | null;
  component_version: string | null;
  component_purl: string | null;
  stable_key: string;
}

function toolResponse(result: ToolResult<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    ...(!result.ok ? { isError: true } : {}),
  };
}

function casMismatch(message: string, details?: unknown): KnownToolError {
  return new KnownToolError({
    code: "cas_mismatch",
    message,
    hint: "Reload the current content hash and retry the write; never last-write-wins.",
    retryable: true,
    details,
  });
}

function toLocalWrite(result: OverlayWriteResult): LocalWrite {
  const diffs: FieldDiff[] = result.changedFields.map((field) => ({
    field,
    from: null,
    to: "updated",
  }));
  const op =
    result.changedFields.length === 0 && result.beforeSha256 !== null
      ? "noop"
      : result.beforeSha256 === null
        ? "create"
        : "update";
  const shaped = writeResult(result.file, op, diffs);
  return {
    path: shaped.path,
    op: shaped.op,
    diffSummary: [...shaped.diffSummary],
    omittedDiffs: shaped.omittedDiffs,
    contentHash: result.afterSha256,
  };
}

function findingByStableKey(
  db: Database.Database,
  platformProjectId: string,
  projectVersionId: string,
  stableKey: string,
): FindingIdentityRow {
  const row = db
    .prepare<[string, string, string], FindingIdentityRow>(
      `SELECT f.project_id, f.cve, f.component_name, f.component_group,
              f.component_version, f.component_purl, f.stable_key
         FROM findings f
         JOIN sync_state s
           ON s.project_id = f.project_id
          AND s.project_version_id = f.project_version_id
          AND s.entity_kind = 'finding'
          AND s.accepted_generation_id = f.generation_id
        WHERE f.project_id = ? AND f.project_version_id = ?
          AND f.stable_key = ? AND f.soft_deleted = 0
        ORDER BY f.finding_id COLLATE BINARY
        LIMIT 1`,
    )
    .get(platformProjectId, projectVersionId, stableKey);
  if (!row || !row.cve || !row.component_name) {
    throw new KnownToolError({
      code: "orphaned_key",
      message: `Stable key ${stableKey} does not resolve against the accepted findings cache.`,
      hint: "Query findings again and use a stable key from the current cache; do not invent keys.",
      retryable: false,
    });
  }
  return row;
}

function publishFindingsHint(
  bb: BbPluginApi,
  projectId: string,
  projectVersionId: string,
  path: string,
): void {
  bb.realtime.publish("findings:changed", {
    projectId,
    projectVersionId,
    path,
  });
}

function createDefaultTriageWriter(
  bb: BbPluginApi,
  ctx: PluginContext,
): TriageWriter {
  return {
    async set(input, scope) {
      const root = await resolveProjectWorktreeRoot(bb, scope.projectId);
      const platformProjectId = acceptedPlatformProjectId(
        ctx.db(),
        scope.projectId,
        input.projectVersionId,
      );
      const finding = findingByStableKey(
        ctx.db(),
        platformProjectId,
        input.projectVersionId,
        input.stableKey,
      );
      const component = {
        purl: finding.component_purl,
        name: finding.component_name,
        group: finding.component_group,
        version: finding.component_version,
      };
      const decisionInput: DecisionInput = {
        project: finding.project_id,
        component,
        cve: finding.cve,
        stableKey: finding.stable_key,
        status: input.status,
        justification: input.justification,
        response: input.response,
        reason: input.reason,
        ...(input.pin !== undefined ? { pin: input.pin } : {}),
        provenance: {
          by: "bb-agent",
          at: new Date().toISOString(),
          evidence: input.evidence,
        },
      };
      try {
        const result = await setDecision(
          root,
          decisionInput,
          input.expectedHash,
        );
        await rebuildOverlayIndex(ctx.db(), root);
        publishFindingsHint(
          bb,
          scope.projectId,
          input.projectVersionId,
          result.file,
        );
        return toLocalWrite(result);
      } catch (error) {
        if (error instanceof OverlayCasConflictError) {
          throw casMismatch(error.message, {
            file: error.file,
            expectedSha256: error.expectedSha256 ?? null,
            currentSha256: error.currentSha256 ?? null,
          });
        }
        if (error instanceof FindingPinError) {
          throw new KnownToolError({
            code: "invalid_pin",
            message: error.message,
            hint: "CODE_NOT_REACHABLE decisions must use pin exact_version.",
            retryable: false,
          });
        }
        throw error;
      }
    },
    async applyPolicy(input, scope) {
      const root = await resolveProjectWorktreeRoot(bb, scope.projectId);
      const platformProjectId = acceptedPlatformProjectId(
        ctx.db(),
        scope.projectId,
        input.projectVersionId,
      );
      const policyScope = {
        projectId: platformProjectId,
        projectVersionId: input.projectVersionId,
        project: platformProjectId,
      };
      const paths: string[] = [];
      const deps = {
        db: ctx.db(),
        root,
        signal: scope.signal,
        setDecision: async (
          decisionRoot: string,
          decision: DecisionInput,
          expectedSha256?: string,
        ) => {
          const result = await setDecision(
            decisionRoot,
            decision,
            expectedSha256,
          );
          if (!paths.includes(result.file)) paths.push(result.file);
          return result;
        },
      };
      try {
        const evaluated = await applyPolicy(deps, policyScope, {
          dryRun: true,
        });
        if (input.dryRun) {
          return {
            paths: [],
            written: 0,
            held: evaluated.held.map((item) => ({
              key: item.stableKey,
              rule: item.rule,
              why: item.why,
            })),
            skippedExisting: evaluated.skippedExisting,
            errors: evaluated.errors.map((error) => ({
              code: error.code,
              message: error.message,
              hint: "Inspect held/skipped keys; policy never overwrites existing decisions or KEV holdbacks.",
              retryable: false,
              details: { stableKey: error.stableKey ?? null },
            })),
            runId: evaluated.runId,
            dryRun: true,
            policySha256: evaluated.policySha256,
          };
        }
        const report = await applyPolicy(deps, policyScope, {
          dryRun: false,
          expectedPolicySha256: evaluated.policySha256,
          evaluated,
        });
        if (paths.length > 0) {
          await rebuildOverlayIndex(ctx.db(), root);
          for (const path of paths) {
            publishFindingsHint(
              bb,
              scope.projectId,
              input.projectVersionId,
              path,
            );
          }
        }
        return {
          paths,
          written: report.written,
          held: report.held.map((item) => ({
            key: item.stableKey,
            rule: item.rule,
            why: item.why,
          })),
          skippedExisting: report.skippedExisting,
          errors: report.errors.map((error) => {
            const retryable = error.code === "OVERLAY_CAS_CONFLICT";
            return {
              code: retryable ? "cas_mismatch" : error.code,
              message: error.message,
              hint: retryable
                ? "Reload the overlay hash and retry; policy never last-write-wins."
                : "Inspect held/skipped keys; policy never overwrites existing decisions or KEV holdbacks.",
              retryable,
              details: { stableKey: error.stableKey ?? null },
            };
          }),
          runId: report.runId,
          dryRun: false,
          policySha256: report.policySha256,
        };
      } catch (error) {
        if (
          error instanceof PolicyApplyError &&
          (error.code === "POLICY_CAS_CONFLICT" ||
            error.code === "POLICY_EVALUATION_STALE")
        ) {
          throw casMismatch(error.message, { code: error.code });
        }
        throw error;
      }
    },
  };
}

function createDefaultRequirementWriter(bb: BbPluginApi): RequirementWriter {
  const repository = createSdkRequirementRepository(bb);
  return {
    async write(input, scope) {
      const candidate = {
        ...input.yaml,
        id: input.reqId,
      };
      const validated = validateRequirement(candidate);
      if (!validated.success) {
        const first = validated.errors[0];
        throw new KnownToolError({
          code: first?.code ?? "requirement_invalid",
          message: first
            ? `${first.code}: ${first.message}`
            : "Requirement failed Gate 1/2 validation.",
          hint: "Fix schema and deterministic lint errors locally; nothing was written.",
          retryable: false,
          details: { errors: validated.errors },
        });
      }
      if (validated.data.id !== input.reqId) {
        throw new KnownToolError({
          code: "requirement_id_mismatch",
          message: "Requirement id must match reqId.",
          hint: "Keep reqId identical to yaml.id.",
          retryable: false,
        });
      }
      const existing = await repository.read(scope.projectId, input.reqId);
      const write = await repository.write(
        scope.projectId,
        validated.data,
        input.expectedHash ?? existing?.sha256 ?? null,
      );
      if (write.outcome === "conflict") {
        throw casMismatch(
          `Requirement changed on disk (current ${write.currentSha256 ?? "missing"}).`,
          { currentSha256: write.currentSha256 },
        );
      }
      const path = `product-security/requirements/${input.reqId}.yaml`;
      const op: LocalWrite["op"] =
        existing === null
          ? "create"
          : existing.sha256 === write.sha256
            ? "noop"
            : "update";
      const diffs: FieldDiff[] =
        op === "noop"
          ? []
          : Object.keys(validated.data)
              .sort()
              .map((field) => ({ field, from: null, to: "updated" }));
      const shaped = writeResult(path, op, diffs);
      bb.realtime.publish("requirements:changed", {
        projectId: scope.projectId,
        requirementId: input.reqId,
        path,
      });
      return {
        path: shaped.path,
        op: shaped.op,
        diffSummary: [...shaped.diffSummary],
        omittedDiffs: shaped.omittedDiffs,
        contentHash: write.sha256,
        gates: {
          schema: "passed",
          lint: "passed",
          humanReview: "pending",
        },
      };
    },
  };
}

function createDefaultHbomExtractor(
  bb: BbPluginApi,
  ctx: PluginContext,
): HbomExtractor {
  return {
    async merge(input, scope) {
      const root = await resolveProjectWorktreeRoot(bb, scope.projectId);
      try {
        const result: ExtractionResult = await applyHbomExtraction(
          {
            db: ctx.db(),
            root,
            projectId: scope.projectId,
            projectVersionId: input.projectVersionId,
          },
          { id: "bb-agent" },
          {
            documentSha256: input.documentSha256,
            expectedHbomSha256: input.expectedHbomSha256,
            createMissingParts: input.createMissingParts,
            proposals: input.cells.map((cell) => ({
              part: cell.part,
              field: cell.field,
              value: cell.value,
              sourceRef: cell.source_ref,
              confidence: cell.confidence,
            })),
          },
        );
        bb.realtime.publish(HBOM_CHANGED_CHANNEL, {
          projectId: scope.projectId,
          path: result.path,
        });
        return {
          path: result.path,
          merged: result.merged,
          queued: result.queued,
          conflicts: result.conflicts,
          candidatesAdded: result.candidatesAdded,
          contentHash: result.hbomSha256,
          diffSummary: result.diffSummary,
          rejected: result.rejected.map((item) => ({
            cell: String(item.index),
            error: {
              code: item.code,
              message: item.message,
              hint: "Valid proposals still commit atomically; rejected cells were not applied.",
              retryable: false,
            },
          })),
        };
      } catch (error) {
        if (error instanceof HbomStaleError) {
          throw casMismatch(error.message, {
            expectedSha256: error.expectedSha256,
            currentSha256: error.currentSha256,
          });
        }
        throw error;
      }
    },
  };
}

function requireWriter<T>(
  ctx: PluginContext,
  key: string,
  factory: () => T,
): T {
  return ctx.service(key, factory);
}

export function registerWriteTools(bb: BbPluginApi, ctx: PluginContext): void {
  const triage = () =>
    requireWriter(ctx, TRIAGE_WRITER_SERVICE, () =>
      createDefaultTriageWriter(bb, ctx),
    );
  const requirements = () =>
    requireWriter(ctx, REQUIREMENT_WRITER_SERVICE, () =>
      createDefaultRequirementWriter(bb),
    );
  const hbom = () =>
    requireWriter(ctx, HBOM_EXTRACTOR_SERVICE, () =>
      createDefaultHbomExtractor(bb, ctx),
    );

  bb.agents.registerTool({
    name: "fs_triage_set",
    description:
      "Write one VEX triage decision to tracked local YAML under .fs/triage only. Local YAML only; a human reviews and pushes. Never contacts Platform or Assurance Studio.",
    parameters: triageSetSchema,
    async execute(input, call: PluginAgentToolContext) {
      const result = await executeSafely(
        async () =>
          ok(
            await triage().set(input, {
              projectId: call.projectId,
              signal: call.signal,
            }),
          ),
        bb.log,
      );
      return toolResponse(result);
    },
  });

  bb.agents.registerTool({
    name: "fs_triage_apply_policy",
    description:
      "Evaluate .fs/triage/policy.yaml and optionally write matching decisions to local YAML. Exposes dryRun; never overwrite_existing. Local YAML only; a human reviews and pushes. Existing human/vendor/manual decisions and KEV holdbacks cannot be overridden.",
    parameters: triageApplyPolicySchema,
    async execute(input, call: PluginAgentToolContext) {
      const result = await executeSafely(
        async () =>
          ok(
            await triage().applyPolicy(input, {
              projectId: call.projectId,
              signal: call.signal,
            }),
          ),
        bb.log,
      );
      return toolResponse(result);
    },
  });

  bb.agents.registerTool({
    name: "fs_requirement_write",
    description:
      "Validate and write one requirement YAML object under product-security/requirements. Gates 1–2 run locally and are all-or-nothing; Gate 3 remains pending human diff review. Local YAML only; a human reviews and pushes. Never writes verification_status or other derived fields.",
    parameters: requirementWriteSchema,
    async execute(input, call: PluginAgentToolContext) {
      const result = await executeSafely(
        async () =>
          ok(
            await requirements().write(input, {
              projectId: call.projectId,
              signal: call.signal,
            }),
          ),
        bb.log,
      );
      return toolResponse(result);
    },
  });

  bb.agents.registerTool({
    name: "fs_hbom_extract",
    description:
      "Submit up to 500 HBOM cell proposals through the merge engine into product-security/hbom.yaml. Agent claims remain proposals; conflicts create candidates. Cannot set accepted, provenance:human, or review status. Local YAML only; a human reviews and pushes.",
    parameters: hbomExtractSchema,
    async execute(input, call: PluginAgentToolContext) {
      const result = await executeSafely(
        async () =>
          ok(
            await hbom().merge(input, {
              projectId: call.projectId,
              signal: call.signal,
            }),
          ),
        bb.log,
      );
      return toolResponse(result);
    },
  });
}
