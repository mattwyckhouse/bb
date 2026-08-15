import type { BbPluginApi, PluginAgentToolContext } from "@bb/plugin-sdk";

import type { PluginContext } from "../../../lib/context.js";
import {
  DEFAULT_PAGE_SIZE,
  SOFT_RESPONSE_BYTES,
  enforceBudget,
  normalizePageSize,
} from "../../../lib/agentic/budget.js";
import { AGENT_TOOL_REGISTRY } from "../../../lib/agentic/registry.js";
import {
  KnownToolError,
  executeSafely,
  ok,
  serializedBytes,
} from "../../../lib/agentic/result.js";
import type { ToolResult } from "../../../lib/agentic/types.js";
import { queryFindings } from "../../findings/cache/query.js";
import { querySbomForProject } from "../../bom/sbom/query.js";
import { listHbomReview } from "../../bom/hbom/review.js";
import type { DocumentsServices } from "../../documents/register.js";
import { listBenchRuns } from "../../bench/store/runs.js";
import { listBenchResults } from "../../bench/store/results.js";
import { listBenchArtifacts } from "../../bench/store/artifacts.js";
import {
  getOtaVerdict,
  projectFrozenVerdict,
} from "../../bench/verdict/query.js";
import {
  status as syncStatus,
  syncMetadata,
} from "../../sync/engine/status.js";
import { plan as syncPlan } from "../../sync/plan/index.js";
import type { EngineDeps } from "../../sync/engine/pull.js";
import { listTara } from "../../product-security/canvas/editing/list-tara.js";
import {
  buildConversionBundle,
  getConversionBundlePage,
  type ConversionCheckSource,
  type ConversionDeps,
  type ConversionPullSnapshot,
  type ConversionReferenceIndex,
  type ConversionSource,
} from "../../product-security/requirements/conversion/bundle.js";
import { validateConversion } from "../../product-security/requirements/conversion/validate.js";
import { createSdkRequirementRepository } from "../../product-security/requirements/cards/adapter.js";
import { requirementIdSchema } from "../../product-security/requirements/cards/schema.js";
import { queryRequirementsTraceability } from "../../product-security/requirements/traceability/query.js";
import { queryVerificationMatrix } from "../../product-security/verifications/matrix/query.js";
import { parseKey } from "../../../lib/sync/registry.js";
import { toStorageProjectVersionId } from "../../../lib/store/index.js";
import type Database from "better-sqlite3";
import {
  benchStatusSchema,
  docSearchSchema,
  earsConvertSchema,
  findingsQuerySchema,
  hbomReviewSchema,
  sbomQuerySchema,
  syncPlanSchema,
  syncStatusSchema,
  taraQuerySchema,
  type BenchStatusInput,
  type DocSearchInput,
  type EarsConvertInput,
  type FindingsQueryInput,
  type HbomReviewInput,
  type SbomQueryInput,
  type SyncPlanInput,
  type SyncStatusInput,
  type TaraQueryInput,
} from "./read-schemas.js";

export const READ_SERVICES_KEY = "agentic.read.services" as const;

export type PageFreshness = {
  cachePulledAt: string | null;
  stale: boolean;
  source: "cache" | "base-snapshot";
  yamlAsOf?: string | null;
  unresolved?: ReadonlyArray<{ from: string; to: string; reason: string }>;
};

export type Page<T> = {
  items: T[];
  total: number;
  cursor: string | null;
  freshness: PageFreshness;
};

export type FindingSummary = {
  id: string;
  cve: string | null;
  component: { name: string; version: string | null; purl: string | null };
  severity: string | null;
  epss: number | null;
  kev: boolean;
  reachability: string | null;
  serverDecision: string | null;
  localDecision: string | null;
  directive: "fs-finding";
};

export type ReadServices = {
  sync: {
    status(input: SyncStatusInput): Promise<unknown> | unknown;
    plan(input: SyncPlanInput): Promise<unknown>;
  };
  findings: {
    query(
      input: FindingsQueryInput,
    ): Page<FindingSummary> | Promise<Page<FindingSummary>>;
  };
  tara: {
    query(input: TaraQueryInput): Page<unknown> | Promise<Page<unknown>>;
    earsBundle(
      input: Extract<EarsConvertInput, { action: "bundle" }>,
    ): Promise<unknown> | unknown;
    earsValidate(
      input: Extract<EarsConvertInput, { action: "validate" }>,
    ): Promise<unknown> | unknown;
  };
  bom: {
    querySbom(input: SbomQueryInput): Page<unknown> | Promise<Page<unknown>>;
    reviewHbom(input: HbomReviewInput): Page<unknown> | Promise<Page<unknown>>;
  };
  bench: {
    status(input: BenchStatusInput): Page<unknown> | Promise<Page<unknown>>;
  };
  documents: {
    search(input: DocSearchInput): Page<unknown> | Promise<Page<unknown>>;
  };
};

function toolResponse(result: ToolResult<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    ...(!result.ok ? { isError: true } : {}),
  };
}

function cacheFreshness(
  cache:
    | {
        state?: string;
        asOf?: string | null;
      }
    | null
    | undefined,
  source: PageFreshness["source"] = "cache",
): PageFreshness {
  const asOf = cache?.asOf ?? null;
  return {
    cachePulledAt: asOf,
    stale: cache?.state === "stale" || cache?.state === "empty",
    source,
  };
}

function measurePageBytes(
  items: unknown[],
  total: number,
  cursor: string | null,
  freshness: PageFreshness,
): number {
  return serializedBytes(
    ok(
      { items, total, cursor, freshness },
      cursor ? { nextCursor: cursor } : {},
    ),
  );
}

/**
 * Row-boundary budget fit: never slice JSON strings. When a full page exceeds
 * the soft target, return a complete shorter prefix and a cursor that resumes
 * by re-querying the owner at the fitted limit.
 */
export async function fitPagedResult<T>(
  fetch: (limit: number) => Promise<Page<T>> | Page<T>,
  requestedLimit: number,
  softBytes = SOFT_RESPONSE_BYTES,
): Promise<Page<T> & { truncated: boolean }> {
  const limit = normalizePageSize(requestedLimit);
  let page = await fetch(limit);
  let bytes = measurePageBytes(
    page.items,
    page.total,
    page.cursor,
    page.freshness,
  );
  if (bytes <= softBytes || page.items.length <= 1) {
    return { ...page, truncated: false };
  }

  let low = 1;
  let high = page.items.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = measurePageBytes(
      page.items.slice(0, mid),
      page.total,
      page.cursor,
      page.freshness,
    );
    if (candidate <= softBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  page = await fetch(best);
  return { ...page, truncated: true };
}

function finalizePage<T>(
  page: Page<T> & { truncated?: boolean },
): ToolResult<Page<T>> {
  return enforceBudget(
    ok(page, {
      ...(page.truncated ? { truncated: true } : {}),
      ...(page.cursor ? { nextCursor: page.cursor } : {}),
    }),
  );
}

async function resolveWorktreeRoot(
  bb: BbPluginApi,
  call: PluginAgentToolContext,
): Promise<string | null> {
  try {
    const thread = await bb.sdk.threads.get({ threadId: call.threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    return environment.path ?? null;
  } catch {
    return null;
  }
}

function createEngineDeps(
  ctx: PluginContext,
  worktreeRoot: string | null,
): EngineDeps {
  return {
    db: ctx.db(),
    worktreeRoot,
    publish: (channel, progress) => ctx.bb.realtime.publish(channel, progress),
  };
}

function mapFindingSummary(finding: {
  stableKey: string;
  cve: string | null;
  componentName: string | null;
  componentVersion: string | null;
  componentPurl: string | null;
  severity: string | null;
  epssScore: number | null;
  inKev: boolean;
  reachabilityVerdict: string | null;
  vexStatus: string | null;
  localState: string;
}): FindingSummary {
  return {
    id: finding.stableKey,
    cve: finding.cve,
    component: {
      name: finding.componentName ?? "unknown",
      version: finding.componentVersion,
      purl: finding.componentPurl,
    },
    severity: finding.severity,
    epss: finding.epssScore,
    kev: finding.inKev,
    reachability: finding.reachabilityVerdict,
    serverDecision: finding.vexStatus,
    localDecision: finding.localState === "none" ? null : finding.localState,
    directive: "fs-finding",
  };
}

function hbomStateFilter(
  state: HbomReviewInput["state"],
): Record<string, string> {
  if (state === "review") return { reason: "proposal" };
  if (state === "conflict") return { reason: "conflict" };
  return {};
}

// --- Ported read-only from requirements/conversion/backend.ts loadPullSnapshot ---
const REQUIREMENTS_DIRECTORY = "product-security/requirements";
const RESULT_SUMMARY_LIMIT = 20;
const REQUIREMENT_TYPES = new Set([
  "security",
  "privacy",
  "safety",
  "regulatory",
  "operational",
]);
const WORKFLOW_STATUSES = new Set([
  "draft",
  "approved",
  "implemented",
  "verified",
]);
const VERIFICATION_METHODS = new Set([
  "config_check",
  "sbom_query",
  "binary_analysis",
  "binary_pattern",
  "vuln_absence",
  "dynamic",
  "external_sync",
  "manual",
  "attestation",
  "document_review",
]);
const VERIFICATION_TIERS = new Set(["static", "emulation", "hil", "manual"]);

interface SnapshotRow {
  entity_key: string;
  remote_id: string | null;
  payload: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function parseRecordJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  const result = record(parsed);
  if (!result) {
    throw new Error(
      "Accepted requirement cache payload must be a JSON object.",
    );
  }
  return result;
}

function stringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

function stringList(
  value: Record<string, unknown>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      );
    }
  }
  return [];
}

function oneOf<T extends string>(
  candidate: string | null,
  allowed: ReadonlySet<string>,
  fallback: T,
): T {
  if (candidate !== null) {
    for (const value of allowed) {
      if (value === candidate) return value as T;
    }
  }
  return fallback;
}

function stableSlug(entityKey: string): string {
  const segments = parseKey(entityKey);
  const slug = segments.at(-1);
  if (!slug) {
    throw new Error("Accepted id_map key does not contain a stable slug.");
  }
  return slug;
}

function normalizeReferences(
  values: readonly string[],
  remoteToSlug: ReadonlyMap<string, string>,
): string[] {
  return [...new Set(values.map((value) => remoteToSlug.get(value) ?? value))];
}

function referenceIndex(
  db: Database.Database,
  projectId: string,
  projectVersionId: string | null,
  generationId: string,
  requirements: readonly SnapshotRow[],
): ConversionReferenceIndex {
  const storageVersion = toStorageProjectVersionId(projectVersionId);
  const idRows = db
    .prepare(
      `SELECT entity_kind, entity_key, remote_id
       FROM id_map
      WHERE project_id = ? AND project_version_id = ? AND generation_id = ?
      ORDER BY entity_kind, entity_key`,
    )
    .all(projectId, storageVersion, generationId) as Array<{
    entity_kind: string;
    entity_key: string;
    remote_id: string;
  }>;
  const checks = db
    .prepare(
      `SELECT code AS slug, check_id AS remote_id
       FROM verification_checks
      WHERE project_id = ? AND project_version_id = ? AND generation_id = ?
      ORDER BY code`,
    )
    .all(projectId, storageVersion, generationId) as Array<{
    slug: string;
    remote_id: string;
  }>;
  const standards = db
    .prepare(
      `SELECT clause_code AS slug, clause_id AS remote_id
       FROM standards_clauses
      WHERE project_id = ? AND project_version_id = ? AND generation_id = ?
      ORDER BY clause_code`,
    )
    .all(projectId, storageVersion, generationId) as Array<{
    slug: string;
    remote_id: string;
  }>;
  const requirementRefs = new Map<string, string>();
  for (const row of requirements) {
    const fields = parseRecordJson(row.payload);
    const id = stringField(fields, "id", "req_id", "reqId", "key");
    if (id && requirementIdSchema.safeParse(id).success && row.remote_id) {
      requirementRefs.set(id, row.remote_id);
    }
  }
  const mitigations = new Map<string, string>();
  const controls = new Map<string, string>();
  for (const row of idRows) {
    if (row.entity_kind === "mitigation") {
      mitigations.set(stableSlug(row.entity_key), row.remote_id);
    }
    if (row.entity_kind === "control") {
      controls.set(stableSlug(row.entity_key), row.remote_id);
    }
  }
  return {
    requirements: requirementRefs,
    checks: new Map(checks.map((row) => [row.slug, row.remote_id])),
    mitigations,
    controls,
    standards: new Map(standards.map((row) => [row.slug, row.remote_id])),
  };
}

function checkSources(
  db: Database.Database,
  projectId: string,
  projectVersionId: string | null,
  generationId: string,
  requirementKey: string,
): ConversionCheckSource[] {
  const storageVersion = toStorageProjectVersionId(projectVersionId);
  const checks = db
    .prepare(
      `SELECT checks.check_id, checks.code, checks.check_type, checks.description,
            checks.pass_criteria, checks.fail_criteria, checks.raw,
            mapping.is_required, mapping.coverage_level, mapping.suppressed
       FROM requirement_check_mappings mapping
       JOIN verification_checks checks
         ON checks.project_id = mapping.project_id
        AND checks.project_version_id = mapping.project_version_id
        AND checks.generation_id = mapping.generation_id
        AND checks.check_id = mapping.check_id
      WHERE mapping.project_id = ? AND mapping.project_version_id = ?
        AND mapping.generation_id = ? AND mapping.requirement_key = ?
      ORDER BY checks.code
      LIMIT 1000`,
    )
    .all(projectId, storageVersion, generationId, requirementKey) as Array<{
    check_id: string;
    code: string;
    check_type: string;
    description: string | null;
    pass_criteria: string | null;
    fail_criteria: string | null;
    raw: string;
    is_required: 0 | 1;
    coverage_level: string | null;
    suppressed: 0 | 1;
  }>;
  return checks.map((check) => {
    if (!check.pass_criteria) {
      throw new Error(
        `Pulled check ${check.code} has no pass criteria to preserve.`,
      );
    }
    const results = db
      .prepare(
        `SELECT tier, status, evidence_summary, executed_at
         FROM verification_results
        WHERE project_id = ? AND project_version_id = ? AND generation_id = ?
          AND requirement_key = ? AND check_id = ? AND is_latest = 1
        ORDER BY executed_at DESC, result_id
        LIMIT ${RESULT_SUMMARY_LIMIT}`,
      )
      .all(
        projectId,
        storageVersion,
        generationId,
        requirementKey,
        check.check_id,
      ) as Array<{
      tier: string;
      status: string;
      evidence_summary: string | null;
      executed_at: string | null;
    }>;
    let raw: Record<string, unknown> = {};
    try {
      raw = parseRecordJson(check.raw);
    } catch {
      raw = {};
    }
    const tier = oneOf(
      stringField(raw, "tier") ?? results[0]?.tier ?? null,
      VERIFICATION_TIERS,
      "static" as const,
    );
    return {
      id: check.check_id,
      slug: check.code,
      method: oneOf(
        check.check_type,
        VERIFICATION_METHODS,
        "document_review" as const,
      ),
      tier,
      required: check.is_required === 1,
      coverage:
        check.coverage_level === "full" ||
        check.coverage_level === "partial" ||
        check.coverage_level === "none"
          ? check.coverage_level
          : null,
      suppressed: check.suppressed === 1,
      description: check.description,
      passCriteria: check.pass_criteria,
      failCriteria: check.fail_criteria,
      resultSummaries: results.map((result) => ({
        status: result.status,
        summary: result.evidence_summary,
        executedAt: result.executed_at,
      })),
    };
  });
}

function conversionSource(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string | null },
  generationId: string,
  row: SnapshotRow,
  remoteToSlug: ReadonlyMap<string, string>,
): ConversionSource {
  const fields = parseRecordJson(row.payload);
  const requirementId = stringField(fields, "id", "req_id", "reqId", "key");
  if (!requirementId || !requirementIdSchema.safeParse(requirementId).success) {
    throw new Error("Pulled requirement is missing its stable REQ-* id.");
  }
  if (!row.remote_id) {
    throw new Error(
      `Pulled requirement ${requirementId} has no remote identity. Pull it again before converting.`,
    );
  }
  const sourceDescription = stringField(
    fields,
    "source_description",
    "sourceDescription",
    "description",
    "statement",
    "title",
  );
  if (!sourceDescription) {
    throw new Error(
      `Pulled requirement ${requirementId} has no source description.`,
    );
  }
  return {
    requirementId,
    remoteId: row.remote_id,
    targetPath: `${REQUIREMENTS_DIRECTORY}/${requirementId}.yaml`,
    sourceDescription,
    reqType: oneOf(
      stringField(fields, "req_type", "reqType"),
      REQUIREMENT_TYPES,
      "security" as const,
    ),
    priority: stringField(fields, "priority") ?? "P2",
    status: oneOf(
      stringField(fields, "status"),
      WORKFLOW_STATUSES,
      "draft" as const,
    ),
    rationale: stringField(fields, "rationale"),
    traces: {
      mitigations: normalizeReferences(
        stringList(fields, "mitigations", "threats", "threatIds"),
        remoteToSlug,
      ),
      controls: normalizeReferences(
        stringList(fields, "controls", "controlIds"),
        remoteToSlug,
      ),
      standards: normalizeReferences(
        stringList(fields, "standards", "standardIds"),
        remoteToSlug,
      ),
    },
    checks: checkSources(
      db,
      scope.projectId,
      scope.projectVersionId,
      generationId,
      row.entity_key,
    ),
    sourceDigest: "",
  };
}

/** Cache-only ConversionDeps: loads base_snapshot rows; never spawns threads. */
export function createCacheConversionDeps(
  ctx: PluginContext,
  scope: { projectId: string; projectVersionId: string | null },
): ConversionDeps {
  return {
    ...scope,
    async loadPullSnapshot(): Promise<ConversionPullSnapshot | null> {
      const storageVersion = toStorageProjectVersionId(scope.projectVersionId);
      const state = ctx
        .db()
        .prepare(
          `SELECT accepted_generation_id, last_pull
           FROM sync_state
          WHERE project_id = ? AND project_version_id = ? AND entity_kind = 'requirement'`,
        )
        .get(scope.projectId, storageVersion) as
        | { accepted_generation_id: string | null; last_pull: string | null }
        | undefined;
      if (!state?.accepted_generation_id || !state.last_pull) return null;
      const generationId = state.accepted_generation_id;
      const rows = ctx
        .db()
        .prepare(
          `SELECT entity_key, remote_id, payload
           FROM base_snapshot
          WHERE project_id = ? AND project_version_id = ? AND entity_kind = 'requirement'
            AND generation_id = ?
          ORDER BY entity_key
          LIMIT 10001`,
        )
        .all(scope.projectId, storageVersion, generationId) as SnapshotRow[];
      const references = referenceIndex(
        ctx.db(),
        scope.projectId,
        scope.projectVersionId,
        generationId,
        rows,
      );
      const remoteToSlug = new Map<string, string>();
      for (const index of [
        references.mitigations,
        references.controls,
        references.standards,
      ]) {
        for (const [slug, remoteId] of index) remoteToSlug.set(remoteId, slug);
      }
      return {
        projectId: scope.projectId,
        pulledAt: state.last_pull,
        requirements: rows.map((row) =>
          conversionSource(ctx.db(), scope, generationId, row, remoteToSlug),
        ),
        references,
      };
    },
    async readLocalFile() {
      return null;
    },
    async spawnOriginPluginThread() {
      throw new KnownToolError({
        code: "ears_write_forbidden",
        message:
          "fs_ears_convert validate/bundle must not spawn conversion threads.",
        hint: "Use action:bundle for cache material and action:validate for gates 1–2 only.",
        retryable: false,
      });
    },
  };
}

function unsupportedTaraKind(kind: TaraQueryInput["kind"]): never {
  throw new KnownToolError({
    code: "unsupported_kind",
    message: `fs_tara_query does not support kind=${kind}.`,
    hint: "Use threat|component|zone|dataflow|asset via listTara, requirement|trace via requirements traceability, or verification via the matrix query. attack_path and clause are not wired as paged list APIs.",
    retryable: false,
  });
}

function filtersRecord(
  filter: TaraQueryInput["filter"],
): Record<string, string> {
  return filter ?? {};
}

export function createDefaultReadServices(
  bb: BbPluginApi,
  ctx: PluginContext,
  call: PluginAgentToolContext,
): ReadServices {
  return {
    sync: {
      async status(input) {
        const worktreeRoot = await resolveWorktreeRoot(bb, call);
        const deps = createEngineDeps(ctx, worktreeRoot);
        const scope = {
          projectId: input.projectId,
          projectVersionId: input.projectVersionId ?? null,
        };
        const report = await syncStatus(deps, scope);
        const metadata = syncMetadata(deps, scope);
        return {
          ...report,
          planDirective: null,
          freshness: cacheFreshness({
            state: metadata.lastPull ? "fresh" : "empty",
            asOf: metadata.lastPull,
          }),
          counts: {
            local: report.local.length,
            upstream: report.upstream.length,
            conflicts: report.conflicts.length,
            orphans: report.orphans.length,
          },
        };
      },
      async plan(input) {
        const worktreeRoot = await resolveWorktreeRoot(bb, call);
        const deps = createEngineDeps(ctx, worktreeRoot);
        const planned = await syncPlan(deps, {
          projectId: input.projectId,
          projectVersionId: input.projectVersionId ?? null,
          pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
          continuation: input.cursor ?? null,
        });
        const stale = planned.staleness.degraded;
        return {
          planId: planned.planId,
          directive: "fs-plan",
          summary: planned.summary,
          blastRadius: planned.blastRadius,
          items: planned.items.map((item) => ({
            id: `${item.kind}:${item.key}`,
            kind: item.kind,
            key: item.key,
            operation: item.operation,
            error: item.error,
          })),
          total: planned.total,
          cursor: planned.next,
          stale,
          basePulledAt: planned.staleness.asOf,
          freshness: {
            cachePulledAt: planned.staleness.asOf,
            stale,
            source: stale ? ("base-snapshot" as const) : ("cache" as const),
          },
          recoveryHint: stale
            ? "Upstream refresh failed or timed out; this plan uses the last-pulled base snapshot. Push-time state may differ — re-run fs_sync_plan when online before asking a human to push."
            : null,
        };
      },
    },
    findings: {
      query(input) {
        const page = queryFindings(ctx.db(), {
          projectId: input.projectId,
          pvId: input.version,
          component: input.component,
          cve: input.cve,
          severity: input.severity,
          reachability: input.reachability,
          kev: input.kev,
          epssGte: input.epss_gte,
          triage: input.triage,
          findingType: input.finding_type,
          cursor: input.cursor,
          limit: input.limit,
        });
        return {
          items: page.items.map(mapFindingSummary),
          total: page.total,
          cursor: page.nextCursor,
          freshness: cacheFreshness(page.cache),
        };
      },
    },
    tara: {
      async query(input) {
        if (
          input.kind === "threat" ||
          input.kind === "component" ||
          input.kind === "zone" ||
          input.kind === "dataflow" ||
          input.kind === "asset"
        ) {
          const page = await listTara(
            bb,
            ctx.db(),
            {
              projectId: input.projectId,
              projectVersionId: input.projectVersionId ?? null,
              pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
              continuation: input.cursor ?? null,
              kind: input.kind,
              filters: filtersRecord(input.filter),
            },
            {
              workspaceProjectId: call.projectId,
              platformProjectId: input.projectId,
            },
          );
          return {
            items: page.items.map(
              (item: {
                key: string;
                label?: string;
                kind?: string;
                fields?: Record<string, unknown>;
              }) => ({
                id: item.key,
                label: item.label ?? item.key,
                kind: item.kind ?? input.kind,
                directive: input.kind === "threat" ? "fs-threat" : "fs-canvas",
                fields: item.fields ?? {},
              }),
            ),
            total: page.total,
            cursor: page.next,
            freshness: {
              ...cacheFreshness(page.cache),
              yamlAsOf: page.cache?.asOf ?? null,
            },
          };
        }

        if (input.kind === "requirement" || input.kind === "trace") {
          const filters = filtersRecord(input.filter);
          if (input.kind === "trace" && !filters.requirementId) {
            throw new KnownToolError({
              code: "not_found",
              message:
                "fs_tara_query kind=trace requires filter.requirementId.",
              hint: "Pass filter.requirementId=REQ-… to load the owner trace rail (including real unresolved gaps).",
              retryable: false,
            });
          }
          const page = await queryRequirementsTraceability({
            bb,
            ctx,
            repository: createSdkRequirementRepository(bb),
            input: {
              projectId: input.projectId,
              projectVersionId: input.projectVersionId ?? null,
              pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
              continuation: input.cursor ?? null,
              filters: { ...filters },
            },
          });
          return {
            items: page.items.map((item) => {
              const fields = item.fields;
              let unresolved:
                | ReadonlyArray<{ from: string; to: string; reason: string }>
                | undefined;
              if (
                typeof fields === "object" &&
                fields !== null &&
                !Array.isArray(fields)
              ) {
                const traceValue = Reflect.get(fields, "trace");
                if (
                  typeof traceValue === "object" &&
                  traceValue !== null &&
                  !Array.isArray(traceValue)
                ) {
                  const rail = Reflect.get(traceValue, "rail");
                  if (
                    typeof rail === "object" &&
                    rail !== null &&
                    !Array.isArray(rail)
                  ) {
                    const gaps = Reflect.get(rail, "gaps");
                    if (Array.isArray(gaps) && gaps.length > 0) {
                      unresolved = gaps.flatMap((gap) => {
                        if (typeof gap !== "object" || gap === null) return [];
                        const from = Reflect.get(gap, "from");
                        const to = Reflect.get(gap, "to");
                        const reason = Reflect.get(gap, "reason");
                        if (
                          typeof from !== "string" ||
                          typeof to !== "string" ||
                          typeof reason !== "string"
                        ) {
                          return [];
                        }
                        return [{ from, to, reason }];
                      });
                    }
                  }
                }
              }
              return {
                id: item.key,
                label: item.label,
                kind: item.kind,
                directive: "fs-threat",
                ...(unresolved && unresolved.length > 0 ? { unresolved } : {}),
              };
            }),
            total: page.total,
            cursor: page.next,
            freshness: cacheFreshness(page.cache),
          };
        }

        if (input.kind === "verification") {
          const page = queryVerificationMatrix(ctx.db(), {
            projectId: input.projectId,
            projectVersionId: input.projectVersionId ?? null,
            pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
            continuation: input.cursor ?? null,
            filters: filtersRecord(input.filter),
          });
          return {
            items: page.items.map((item) => ({
              id: item.key,
              label: item.label,
              kind: item.kind,
              directive: "fs-threat",
            })),
            total: page.total,
            cursor: page.next,
            freshness: cacheFreshness(page.cache),
          };
        }

        return unsupportedTaraKind(input.kind);
      },
      async earsBundle(input) {
        const deps = createCacheConversionDeps(ctx, {
          projectId: input.projectId,
          projectVersionId: input.projectVersionId ?? null,
        });
        const meta = await buildConversionBundle(deps, input.req_ids);
        const page = await getConversionBundlePage(meta.bundleId);
        return {
          ...meta,
          items: page.items.map((source) => ({
            id: source.requirementId,
            remoteId: source.remoteId,
            targetPath: source.targetPath,
            checkCount: source.checks.length,
          })),
          cursor: page.nextCursor,
          freshness: {
            cachePulledAt: meta.pulledAt,
            stale: false,
            source: "cache" as const,
          },
          forgeCalls: 0,
        };
      },
      async earsValidate(input) {
        const results = await validateConversion(input.paths, input.bundleId);
        return {
          results: results.map((result) => ({
            requirementId: result.requirementId,
            schemaOk: result.schema.ok,
            schemaErrors: result.schema.errors.slice(0, 20),
            roundTripOk: result.roundTrip.ok,
            unresolved: result.roundTrip.unresolved,
            staleSource: result.roundTrip.staleSource,
            humanReview: result.humanReview,
          })),
          wrote: false,
        };
      },
    },
    bom: {
      querySbom(input) {
        const page = querySbomForProject(ctx.db(), input.projectId, {
          projectVersionId: input.version,
          search: input.name,
          purl: input.purl,
          license: input.license,
          minimumSeverity: input.min_severity,
          kev: input.kev,
          reachability: input.reachability,
          linked: input.linked,
          cursor: input.cursor,
          limit: input.limit,
        });
        return {
          items: page.items.map((item) => ({
            id: item.componentKey,
            purl: item.purl,
            name: item.name,
            version: item.version,
            license: item.license,
            vuln: item.vuln,
            fileCount: item.files.length,
            directive: "fs-component",
          })),
          total: page.total,
          cursor: page.cursor,
          freshness: cacheFreshness(page.cache),
        };
      },
      async reviewHbom(input) {
        const page = await listHbomReview(
          { db: ctx.db(), root: (await resolveWorktreeRoot(bb, call)) ?? "." },
          {
            projectId: input.projectId,
            projectVersionId: input.projectVersionId ?? null,
            pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
            continuation: input.cursor ?? null,
            filters: hbomStateFilter(input.state),
          },
        );
        return {
          items: page.items.map((item) => ({
            id: item.key,
            label: item.label,
            kind: item.kind,
            // Summaries only — no accept/reject callbacks.
            fields: {
              partId: item.fields.partId ?? null,
              field: item.fields.field ?? null,
              state: item.fields.state ?? null,
              reason: item.fields.reason ?? null,
              confidence: item.fields.confidence ?? null,
              candidateCount: item.fields.candidateCount ?? null,
              sourceRef: item.fields.sourceRef ?? null,
              provenance: item.fields.provenance ?? null,
            },
          })),
          total: page.total,
          cursor: page.next,
          freshness: cacheFreshness(page.cache),
          mutation: null,
        };
      },
    },
    bench: {
      async status(input) {
        const pvId = input.pv_id;
        if (input.want === "verdict") {
          if (!pvId) {
            throw new KnownToolError({
              code: "bench_verdict_requires_pv",
              message: "fs_bench_status want=verdict requires pv_id.",
              hint: "Pass pv_id for the firmware version whose safe-to-OTA verdict you need.",
              retryable: false,
            });
          }
          const verdict = await getOtaVerdict(
            { db: ctx.db(), projectId: input.projectId },
            pvId,
          );
          const verdictId = verdict.firmwareDigest ?? `verdict:${pvId}`;
          const projected = projectFrozenVerdict(
            ctx.db(),
            input.projectId,
            verdictId,
            verdict,
          );
          return {
            items: [
              {
                id: projected.id,
                directive: "fs-verdict",
                status: projected.verdict,
                digest: projected.firmwareSha256,
                evidenceIds: projected.evidenceIds,
                computedAt: projected.cache.asOf,
              },
            ],
            total: 1,
            cursor: null,
            freshness: cacheFreshness(projected.cache),
          };
        }

        if (!pvId) {
          throw new KnownToolError({
            code: "bench_status_requires_pv",
            message: `fs_bench_status want=${input.want} requires pv_id.`,
            hint: "Pass pv_id to list runs, results, or artifacts from the local cache.",
            retryable: false,
          });
        }

        if (input.want === "runs") {
          const page = listBenchRuns(ctx.db(), {
            projectId: input.projectId,
            pvId,
            pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
            continuation: input.cursor ?? null,
          });
          return {
            items: page.items.map((run) => ({
              id: run.runId,
              directive: "fs-bench",
              status: run.status,
              tier: run.tier,
              startedAt: run.startedAt,
            })),
            total: page.total,
            cursor: page.next,
            freshness: cacheFreshness(page.cache),
          };
        }

        if (!input.run_id) {
          throw new KnownToolError({
            code: "bench_status_requires_run",
            message: `fs_bench_status want=${input.want} requires run_id.`,
            hint: "Pass run_id from a prior want=runs query. Log and artifact bodies are never returned.",
            retryable: false,
          });
        }

        if (input.want === "results") {
          const page = listBenchResults(ctx.db(), {
            projectId: input.projectId,
            pvId,
            runId: input.run_id,
            pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
            continuation: input.cursor ?? null,
          });
          return {
            items: page.items.map((result) => ({
              id: result.resultId,
              runId: input.run_id,
              status: result.outcome,
              checkId: result.checkId,
            })),
            total: page.total,
            cursor: page.next,
            freshness: cacheFreshness(page.cache),
          };
        }

        const page = listBenchArtifacts(ctx.db(), {
          projectId: input.projectId,
          pvId,
          runId: input.run_id,
          pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
          continuation: input.cursor ?? null,
        });
        return {
          items: page.items.map((artifact) => ({
            id: artifact.artifactId,
            runId: input.run_id,
            kind: artifact.kind,
            name: artifact.name,
            sha256: artifact.sha256,
          })),
          total: page.total,
          cursor: page.next,
          freshness: cacheFreshness(page.cache),
        };
      },
    },
    documents: {
      search(input) {
        const services = ctx.service<DocumentsServices>(
          "documents.services",
          () => {
            throw new KnownToolError({
              code: "documents_service_missing",
              message: "Documents search service is not registered.",
              hint: "Ensure registerDocuments ran before registerReadTools.",
              retryable: false,
            });
          },
        );
        const page = services.searchDocuments(
          ctx.db(),
          {
            projectId: input.project_id,
            projectVersionId: input.project_version_id ?? null,
          },
          {
            query: input.query,
            kinds: input.doc_type ? [input.doc_type] : undefined,
            pageSize: input.limit ?? DEFAULT_PAGE_SIZE,
            continuation: input.cursor ?? null,
          },
        );
        return {
          items: page.items.map((hit) => ({
            id: hit.documentSha256,
            documentName: hit.documentName,
            field: hit.field,
            confidence: hit.confidence,
            sourceRef: hit.sourceRef,
            target: hit.target ?? null,
            directive: "fs-doc",
          })),
          total: page.total ?? page.items.length,
          cursor: page.next,
          freshness: cacheFreshness(page.cache),
        };
      },
    },
  };
}

function resolveReadServices(
  bb: BbPluginApi,
  ctx: PluginContext,
  call: PluginAgentToolContext,
  override?: ReadServices,
): ReadServices {
  if (override) return override;
  return createDefaultReadServices(bb, ctx, call);
}

export function registerReadTools(
  bb: BbPluginApi,
  ctx: PluginContext,
  services?: ReadServices,
): void {
  const registry = AGENT_TOOL_REGISTRY;

  bb.agents.registerTool({
    name: "fs_sync_status",
    description:
      "Report local / upstream / conflict / orphan sync counts and keys from the local worktree and last-pulled base. Read-only; never pushes. Pair follow-ups with fs_sync_plan before asking a human to push.",
    parameters: syncStatusSchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          return ok(await read.sync.status(input));
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_sync_plan",
    description:
      "Compute a read-only push plan (creates/updates/deletes/conflicts/orphans + blast radius). Performs an optional upstream tuple refresh for conflict detection but never mutates upstream. Offline/timeout degrades to the last-pulled base with stale:true. Render with ::fs-plan{id}.",
    parameters: syncPlanSchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          return ok(await read.sync.plan(input));
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_findings_query",
    description: `Query cached findings; returns stable keys for ::${registry.fs_findings_query.directive}{id}. Filters: version, component, cve, severity, reachability, kev, epss_gte, triage, finding_type, limit/cursor. Never returns raw finding payloads or ephemeral finding UUIDs as identity.`,
    parameters: findingsQuerySchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          const fitted = await fitPagedResult(
            (limit) => read.findings.query({ ...input, limit }),
            input.limit ?? DEFAULT_PAGE_SIZE,
          );
          return finalizePage(fitted);
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_tara_query",
    description:
      "Query the product-security model (threats, components, zones, dataflows, attack paths, requirements, verification, clauses, trace) from local YAML + cache. Returns directive-ready slugs for ::fs-threat{id} / ::fs-canvas{focus}. Unresolved YAML⋈cache links are reported, never dropped.",
    parameters: taraQuerySchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          const fitted = await fitPagedResult(
            (limit) => read.tara.query({ ...input, limit }),
            input.limit ?? DEFAULT_PAGE_SIZE,
          );
          return finalizePage(fitted);
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_ears_convert",
    description:
      "EARS conversion scaffolding: action=bundle returns cache-served AS requirement/check/result source material (never a live Forge/AS call); action=validate runs gates 1–2 only and never writes.",
    parameters: earsConvertSchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          if (input.action === "bundle") {
            return ok(await read.tara.earsBundle(input));
          }
          return ok(await read.tara.earsValidate(input));
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_sbom_query",
    description:
      "Query cached SBOM components with vuln rollups and file counts. Returns componentKey ids for ::fs-component{purl|part}. Filters: version, name, purl, license, min_severity, kev, reachability, linked, limit/cursor.",
    parameters: sbomQuerySchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          const fitted = await fitPagedResult(
            (limit) => read.bom.querySbom({ ...input, limit }),
            input.limit ?? DEFAULT_PAGE_SIZE,
          );
          return finalizePage(fitted);
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_hbom_review",
    description:
      "List the HBOM review queue (values, candidates, provenance, source refs). Read-only — acceptance/rejection is human-only; agents may only propose better-evidenced cells via fs_hbom_extract.",
    parameters: hbomReviewSchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          const fitted = await fitPagedResult(
            (limit) => read.bom.reviewHbom({ ...input, limit }),
            input.limit ?? DEFAULT_PAGE_SIZE,
          );
          return finalizePage(fitted);
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_bench_status",
    description:
      "List/get bench runs, results, artifacts, and the safe-to-OTA verdict from the SQLite cache. Returns ids for ::fs-bench{id} and ::fs-verdict{id}. Never returns log or artifact bodies.",
    parameters: benchStatusSchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          const fitted = await fitPagedResult(
            (limit) => read.bench.status({ ...input, limit }),
            input.limit ?? DEFAULT_PAGE_SIZE,
          );
          return finalizePage(fitted);
        }, bb.log),
      );
    },
  });

  bb.agents.registerTool({
    name: "fs_doc_search",
    description:
      "Search documents and agent-extracted structure. Returns matches with page/region source_refs for ::fs-doc{id}. Never uploads, edits, or returns document bodies.",
    parameters: docSearchSchema,
    async execute(input, call) {
      return toolResponse(
        await executeSafely(async () => {
          const read = resolveReadServices(bb, ctx, call, services);
          const fitted = await fitPagedResult(
            (limit) => read.documents.search({ ...input, limit }),
            input.limit ?? DEFAULT_PAGE_SIZE,
          );
          return finalizePage(fitted);
        }, bb.log),
      );
    },
  });
}
