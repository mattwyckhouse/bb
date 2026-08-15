import type { BbPluginApi } from "@bb/plugin-sdk";
import type { PluginContext } from "../../lib/context.js";
import type Database from "better-sqlite3";
import { dirname, isAbsolute } from "node:path";
import type { PlatformClient, RemoteServices } from "../../lib/remote/types.js";
import {
  backfillUnambiguousWorkspaceProjectBinding,
  WORKSPACE_PLATFORM_PROJECT_PREDICATE,
} from "../../lib/store/project-scope.js";
import type { JsonValue } from "../../shared/contract.js";
import { rpcContract } from "../../shared/contract.js";
import { resolveProjectWorktreeRoot } from "../documents/store.js";
import { registerCachePuller } from "../sync/engine/adapter.js";
import { applyHbomExtractionRpc, type ExtractionDeps } from "./hbom/extract.js";
import {
  createHbomCycloneDxHttpHandler,
  createHbomXlsxHttpHandler,
} from "./hbom/export/http.js";
import {
  getHbomComponent,
  listHbomReview,
  resolveHbomReview,
  type ReviewDeps,
} from "./hbom/review.js";
import { createSbomHttpHandler } from "./sbom/export-http.js";
import { pullSbom } from "./sbom/pull.js";
import {
  queryComponentFindings,
  queryComponentLinks,
  querySbomForProject,
  type SbomSort,
  type SbomSortDirection,
  type SbomUiQuery,
} from "./sbom/query.js";
import type {
  SbomReachability,
  SbomSeverity,
  SbomPullInput,
  SbomPullResult,
} from "./sbom/types.js";
import { bomCachedVersionsContract } from "./rpc.js";

const bomRpcContract = {
  bomSoftwareList: rpcContract.bomSoftwareList,
  bomComponentGet: rpcContract.bomComponentGet,
  hbomReviewList: rpcContract.hbomReviewList,
  hbomReviewResolve: rpcContract.hbomReviewResolve,
  hbomExtractionApply: rpcContract.hbomExtractionApply,
} as const;

export interface BomCommandServices {
  pull(
    input: SbomPullInput & {
      stagingRoot: string;
      signal?: AbortSignal;
      generationId: string;
      onProgress?: (progress: { pages: number }) => void;
    },
  ): Promise<SbomPullResult>;
}

async function platformScopeNames(
  platform: PlatformClient,
  scopes: readonly { projectId: string; projectVersionId: string }[],
): Promise<{
  projects: ReadonlyMap<string, string>;
  versions: ReadonlyMap<string, string>;
}> {
  const projects = new Map<string, string>();
  const versions = new Map<string, string>();
  try {
    for await (const page of platform.listProjects({ pageSize: 200 })) {
      for (const item of page.items) {
        const id = item["id"];
        const name = item["name"];
        if (typeof id === "string" && typeof name === "string") {
          projects.set(id, name);
        }
      }
    }
    for (const projectId of new Set(scopes.map((scope) => scope.projectId))) {
      for await (const page of platform.listVersions(projectId, {
        pageSize: 200,
      })) {
        for (const item of page.items) {
          const id = item["id"];
          const name = item["name"];
          if (typeof id === "string" && typeof name === "string") {
            versions.set(id, name);
          }
        }
      }
    }
  } catch {
    // Accepted cached scopes remain usable while Platform is unavailable.
  }
  return { projects, versions };
}

export function createBomCommandServices(
  bb: BbPluginApi,
  db: Database.Database,
  platform: () => Pick<PlatformClient, "listComponents" | "listVersions">,
): BomCommandServices {
  return {
    pull({ stagingRoot, signal, generationId, onProgress, ...input }) {
      return pullSbom(
        {
          db,
          platform: platform(),
          stagingRoot,
          generationId,
          ...(signal ? { signal } : {}),
          publishProgress(hint) {
            bb.realtime.publish("bom:progress", hint);
            onProgress?.({ pages: hint.pages });
          },
          warn(message, details) {
            bb.log.warn(
              `${message}: ${details.count} for project version ${details.projectVersionId}`,
            );
          },
        },
        input,
      );
    },
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function jsonFilters(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const filters: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonValue(entry)) filters[key] = entry;
  }
  return filters;
}

function optionalString(
  filters: Record<string, JsonValue>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = filters[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function optionalBoolean(
  filters: Record<string, JsonValue>,
  key: string,
): boolean | undefined {
  const value = filters[key];
  return typeof value === "boolean" ? value : undefined;
}

function isSeverity(value: string | undefined): value is SbomSeverity {
  return (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low"
  );
}

function isReachability(value: string | undefined): value is SbomReachability {
  return (
    value === "reachable" ||
    value === "unreachable" ||
    value === "mixed" ||
    value === "unknown"
  );
}

function isSort(value: string | undefined): value is SbomSort {
  return (
    value === "name" ||
    value === "severity" ||
    value === "kev" ||
    value === "license"
  );
}

function isSortDirection(
  value: string | undefined,
): value is SbomSortDirection {
  return value === "asc" || value === "desc";
}

const SOFTWARE_FILTERS = new Set([
  "architectureLinked",
  "componentKey",
  "component_key",
  "direction",
  "kev",
  "license",
  "linked",
  "localChange",
  "min_severity",
  "minimumSeverity",
  "name",
  "purl",
  "reachability",
  "search",
  "sort",
  "source",
]);

function softwareQuery(input: {
  projectVersionId: string | null;
  pageSize: number;
  continuation: string | null;
  filters?: Record<string, JsonValue>;
}): SbomUiQuery {
  if (input.projectVersionId === null) {
    throw new Error(
      "SBOM_PROJECT_VERSION_REQUIRED: software inventory is version-scoped",
    );
  }
  const filters = input.filters ?? {};
  const severity = optionalString(filters, "minimumSeverity", "min_severity");
  const reachability = optionalString(filters, "reachability");
  const sort = optionalString(filters, "sort");
  const direction = optionalString(filters, "direction");
  const unknown = Object.keys(filters).filter(
    (key) => !SOFTWARE_FILTERS.has(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `SBOM_FILTER_INVALID: unsupported filters: ${unknown.sort().join(", ")}`,
    );
  }
  if (severity && !isSeverity(severity)) {
    throw new Error("SBOM_FILTER_INVALID: minimum severity is invalid");
  }
  if (reachability && !isReachability(reachability)) {
    throw new Error("SBOM_FILTER_INVALID: reachability is invalid");
  }
  if (sort && !isSort(sort))
    throw new Error("SBOM_FILTER_INVALID: sort is invalid");
  if (direction && !isSortDirection(direction)) {
    throw new Error("SBOM_FILTER_INVALID: direction is invalid");
  }
  const linked =
    optionalBoolean(filters, "linked") ??
    optionalBoolean(filters, "architectureLinked");
  return {
    projectVersionId: input.projectVersionId,
    limit: input.pageSize,
    ...(input.continuation ? { cursor: input.continuation } : {}),
    ...(optionalString(filters, "search", "name")
      ? {
          search: optionalString(filters, "search", "name"),
        }
      : {}),
    ...(optionalString(filters, "purl")
      ? { purl: optionalString(filters, "purl") }
      : {}),
    ...(optionalString(filters, "license")
      ? { license: optionalString(filters, "license") }
      : {}),
    ...(isSeverity(severity) ? { minimumSeverity: severity } : {}),
    ...(optionalBoolean(filters, "kev") !== undefined
      ? { kev: optionalBoolean(filters, "kev") }
      : {}),
    ...(isReachability(reachability) ? { reachability } : {}),
    ...(optionalString(filters, "source")
      ? { source: optionalString(filters, "source") }
      : {}),
    ...(linked !== undefined ? { linked } : {}),
    ...(optionalBoolean(filters, "localChange") !== undefined
      ? { localChange: optionalBoolean(filters, "localChange") }
      : {}),
    ...(isSort(sort) ? { sort } : {}),
    ...(isSortDirection(direction) ? { direction } : {}),
    ...(optionalString(filters, "componentKey", "component_key")
      ? {
          componentKey: optionalString(
            filters,
            "componentKey",
            "component_key",
          ),
        }
      : {}),
  };
}

export function registerBom(bb: BbPluginApi, ctx: PluginContext): void {
  const db = ctx.db();
  const commands = ctx.service("bom.command-services", () =>
    createBomCommandServices(
      bb,
      db,
      () =>
        ctx.service<RemoteServices>("remote-services", () => {
          throw new Error("REMOTE_SERVICES_NOT_REGISTERED");
        }).platform,
    ),
  );
  registerCachePuller(
    "sbomComponent",
    async (scope, generationId, onProgress) => {
      if (scope.projectVersionId === null) {
        throw new Error(
          "SBOM_PROJECT_VERSION_REQUIRED: software inventory is version-scoped",
        );
      }
      if (db.memory || !isAbsolute(db.name)) {
        throw new Error("SBOM_STAGING_ROOT_UNAVAILABLE");
      }
      const result = await commands.pull({
        projectId: scope.projectId,
        projectVersionId: scope.projectVersionId,
        stagingRoot: dirname(db.name),
        resume: true,
        generationId,
        onProgress: ({ pages }) => onProgress({ page: pages, of: null }),
      });
      return {
        fetched: result.fetched,
        baseRows: result.components,
        quarantined: result.quarantined,
        advisories: [],
      };
    },
  );
  bb.rpc.register(bomCachedVersionsContract, {
    async bomCachedProjectVersions(input) {
      const project = await bb.sdk.projects.get({ projectId: input.projectId });
      if (project.sources.length === 0) {
        throw new Error("BOM_PROJECT_SOURCE_REQUIRED");
      }
      backfillUnambiguousWorkspaceProjectBinding(db, input.projectId);
      const rows = db
        .prepare<
          [string],
          {
            project_id: string;
            project_version_id: string;
            as_of: string | null;
            stale: number;
          }
        >(
          `SELECT project_id, project_version_id,
                MAX(CASE WHEN entity_kind = 'sbomComponent' THEN last_pull END) AS as_of,
                MAX(CASE
                      WHEN entity_kind = 'sbomComponent' AND error IS NOT NULL THEN 1
                      ELSE 0
                    END) AS stale
           FROM sync_state s
          WHERE ${WORKSPACE_PLATFORM_PROJECT_PREDICATE}
            AND s.entity_kind IN ('finding', 'sbomComponent')
            AND s.accepted_generation_id IS NOT NULL
          GROUP BY s.project_id, s.project_version_id
          ORDER BY MAX(s.last_pull) DESC, s.project_id ASC, s.project_version_id ASC`,
        )
        .all(input.projectId);
      const versions = rows.map((row) => ({
        platformProjectId: row.project_id,
        platformProjectName: null,
        projectVersionId: row.project_version_id,
        projectVersionName: null,
        asOf: row.as_of,
        state: row.stale === 1 ? ("stale" as const) : ("fresh" as const),
      }));
      let names: Awaited<ReturnType<typeof platformScopeNames>> = {
        projects: new Map(),
        versions: new Map(),
      };
      try {
        const remote = ctx.service<RemoteServices>("remote-services", () => {
          throw new Error("REMOTE_SERVICES_NOT_REGISTERED");
        });
        names = await platformScopeNames(
          remote.platform,
          versions.map((version) => ({
            projectId: version.platformProjectId,
            projectVersionId: version.projectVersionId,
          })),
        );
      } catch {
        // Cached scopes remain usable when display-name enrichment is offline.
      }
      return {
        versions: versions.map((version) => ({
          ...version,
          platformProjectName:
            names.projects.get(version.platformProjectId) ?? null,
          projectVersionName:
            names.versions.get(version.projectVersionId) ?? null,
        })),
        selectedPlatformProjectId: versions[0]?.platformProjectId ?? null,
        selectedProjectVersionId: versions[0]?.projectVersionId ?? null,
      };
    },
  });
  bb.rpc.register(bomRpcContract, {
    bomSoftwareList(input) {
      const page = querySbomForProject(
        db,
        input.projectId,
        softwareQuery(input),
      );
      return {
        items: page.items.map((component) => ({
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          kind: "sbomComponent",
          key: component.componentKey,
          label: component.name,
          fields: {
            purl: component.purl,
            cpe: component.cpe,
            group: component.group,
            version: component.version,
            license: component.license,
            supplier: component.supplier,
            source: component.source,
            upstreamStale: component.upstreamStale,
            files: component.files,
            fileCount: component.files.length,
            localChange: component.localChange,
            linked: component.linked,
            vuln: component.vuln,
            pulledAt: component.pulledAt,
          },
        })),
        total: page.total,
        next: page.cursor,
        cache: page.cache,
      };
    },
    async bomComponentGet(input) {
      if (input.mode === "hardware") {
        const root = await resolveProjectWorktreeRoot(bb, input.projectId);
        const deps: ReviewDeps = { db, root };
        return getHbomComponent(deps, {
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          componentId: input.componentId,
        });
      }
      if (input.projectVersionId === null) {
        throw new Error(
          "SBOM_PROJECT_VERSION_REQUIRED: software inventory is version-scoped",
        );
      }
      const page = querySbomForProject(db, input.projectId, {
        projectVersionId: input.projectVersionId,
        componentKey: input.componentId,
        limit: 1,
      });
      const component = page.items[0];
      if (!component) throw new Error("SBOM_COMPONENT_NOT_FOUND");
      const projectedLinks = queryComponentLinks(
        db,
        input.projectId,
        input.projectVersionId,
        component.purl,
      );
      const findings = queryComponentFindings(
        db,
        input.projectId,
        input.projectVersionId,
        component.componentKey,
      );
      return {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
        kind: "sbomComponent",
        key: component.componentKey,
        label: component.name,
        fields: {
          purl: component.purl,
          cpe: component.cpe,
          group: component.group,
          version: component.version,
          license: component.license,
          supplier: component.supplier,
          source: component.source,
          upstreamStale: component.upstreamStale,
          files: component.files,
          fileCount: component.files.length,
          findings,
          localChange: component.localChange,
          linked: component.linked,
          vuln: component.vuln,
          pulledAt: component.pulledAt,
        },
        links: projectedLinks.map((link) => ({
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          kind: link.kind,
          key: link.key,
          label: link.label,
        })),
        cache: page.cache,
      };
    },
    async hbomReviewList(input) {
      const root = await resolveProjectWorktreeRoot(bb, input.projectId);
      const deps: ReviewDeps = { db, root };
      return listHbomReview(deps, {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
        pageSize: input.pageSize,
        continuation: input.continuation,
        filters: jsonFilters(Reflect.get(input, "filters")),
      });
    },
    async hbomReviewResolve(input) {
      const root = await resolveProjectWorktreeRoot(bb, input.projectId);
      const deps: ReviewDeps = { db, root };
      return resolveHbomReview(deps, input);
    },
    async hbomExtractionApply(input) {
      const root = await resolveProjectWorktreeRoot(bb, input.projectId);
      const deps: ExtractionDeps = {
        db,
        root,
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
      };
      return applyHbomExtractionRpc(deps, input);
    },
  });

  bb.http.route(
    "GET",
    "/sbom/export",
    createSbomHttpHandler({
      get platform() {
        return ctx.service<RemoteServices>("remote-services", () => {
          throw new Error("REMOTE_SERVICES_NOT_REGISTERED");
        }).platform;
      },
    }),
  );
  bb.http.route(
    "GET",
    "/hbom/export.xlsx",
    createHbomXlsxHttpHandler({ db, bb }),
  );
  bb.http.route(
    "GET",
    "/hbom/export.cdx.json",
    createHbomCycloneDxHttpHandler({ db, bb }),
  );
}
