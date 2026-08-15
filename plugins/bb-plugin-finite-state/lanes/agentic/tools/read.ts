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
  type ConversionDeps,
  type ConversionPullSnapshot,
} from "../../product-security/requirements/conversion/bundle.js";
import { validateConversion } from "../../product-security/requirements/conversion/validate.js";
import { toStorageProjectVersionId } from "../../../lib/store/index.js";
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

function createCacheConversionDeps(
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
      // Bundle material is cache-served only. Empty requirements still prove
      // the adapter never reached Forge/AS for conversion scaffolding.
      return {
        projectId: scope.projectId,
        pulledAt: state.last_pull,
        requirements: [],
        references: {
          requirements: new Map(),
          checks: new Map(),
          mitigations: new Map(),
          controls: new Map(),
          standards: new Map(),
        },
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
              filters: input.filter ?? {},
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

        // Trace / requirement / verification / clause / attack_path: surface
        // unresolved links explicitly rather than dropping them. Full index
        // joins for every kind remain owner-owned; this boundary adapts.
        const unresolved = input.filter?.unresolved
          ? [
              {
                from: input.filter.from ?? input.kind,
                to: input.filter.to ?? "unknown",
                reason: input.filter.unresolved,
              },
            ]
          : input.kind === "trace" ||
              input.kind === "attack_path" ||
              input.kind === "clause"
            ? [
                {
                  from: input.kind,
                  to:
                    input.filter?.requirementId ??
                    input.filter?.id ??
                    "unspecified",
                  reason:
                    "Link is unresolved in the local YAML⋈cache join; inspect .fs/ and pull product-security before treating it as absent.",
                },
              ]
            : [];

        return {
          items: unresolved.map((gap) => ({
            id: `${gap.from}->${gap.to}`,
            kind: input.kind,
            directive: "fs-threat",
            unresolved: gap,
          })),
          total: unresolved.length,
          cursor: null,
          freshness: {
            cachePulledAt: null,
            stale: true,
            source: "cache" as const,
            yamlAsOf: null,
            unresolved,
          },
        };
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
            // Omit check result bodies / full source text.
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
