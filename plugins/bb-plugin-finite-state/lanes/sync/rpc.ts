import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import type {
  AssuranceStudioClient,
  PlatformClient,
} from "../../lib/remote/types.js";
import { resolvePlatformScopeNames } from "../../lib/remote/platform/scope-names.js";
import {
  connectionStatusMessage,
  diagnoseRemoteFailure,
} from "../../lib/remote/errors.js";
import {
  backfillUnambiguousWorkspaceProjectBinding,
  bindWorkspacePlatformProject,
  WORKSPACE_PLATFORM_PROJECT_PREDICATE,
} from "../../lib/store/project-scope.js";
import { ENTITIES, type EntityKind } from "../../lib/sync/registry.js";
import { rpcContract } from "../../shared/contract.js";
import { resolveConflictRpc } from "./conflicts/index.js";
import { pullIsolated, type EngineDeps } from "./engine/pull.js";
import { assertRemoteSyncScope } from "./engine/scope.js";
import { status, syncMetadata } from "./engine/status.js";
import { plan } from "./plan/index.js";
import { pushAuthorizationUnavailable } from "./push/index.js";
import {
  assuranceStudioProjectCandidateState,
  enumerateAssuranceStudioProjectCandidates,
  selectedAssuranceStudioProject,
  selectAssuranceStudioProject,
} from "./as-project-binding.js";

const syncContract = {
  syncPull: rpcContract.syncPull,
  syncAsProjectCandidates: rpcContract.syncAsProjectCandidates,
  syncAsProjectSelect: rpcContract.syncAsProjectSelect,
  syncStatus: rpcContract.syncStatus,
  syncPlan: rpcContract.syncPlan,
  syncConflictResolve: rpcContract.syncConflictResolve,
  syncPush: rpcContract.syncPush,
  syncPushRetry: rpcContract.syncPushRetry,
};

const cachedSyncScopesRpc = {
  input: z.object({ workspaceProjectId: z.string().min(1).max(512) }).strict(),
  output: z
    .object({
      scopes: z.array(
        z
          .object({
            platformProjectId: z.string().min(1).max(512),
            platformProjectName: z.string().min(1).max(512).nullable(),
            projectVersionId: z.string().min(1).max(512),
            projectVersionName: z.string().min(1).max(512).nullable(),
            state: z.enum(["fresh", "stale"]),
          })
          .strict(),
      ),
    })
    .strict(),
} as const;

const platformScopeNamesRpc = {
  input: z
    .object({
      scopes: z
        .array(
          z
            .object({
              projectId: z.string().min(1).max(512),
              projectVersionId: z.string().min(1).max(512),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  output: z
    .object({
      scopes: z.array(
        z
          .object({
            projectId: z.string().min(1).max(512),
            projectName: z.string().min(1).max(512).nullable(),
            projectVersionId: z.string().min(1).max(512),
            projectVersionName: z.string().min(1).max(512).nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
} as const;

export const syncScopeCatalogContract = defineRpcContract({
  syncCachedScopes: cachedSyncScopesRpc,
  syncPlatformScopeNames: platformScopeNamesRpc,
});

export const syncAppRpcContract = defineRpcContract({
  connectionsStatus: rpcContract.connectionsStatus,
  ...syncContract,
  syncCachedScopes: cachedSyncScopesRpc,
  syncPlatformScopeNames: platformScopeNamesRpc,
});

function entityKinds(values: string[] | undefined): EntityKind[] | undefined {
  if (values === undefined) return undefined;
  return values.map((value) => {
    if (!Object.hasOwn(ENTITIES, value))
      throw new Error(`Unknown Finite State entity kind: ${value}`);
    return value as EntityKind;
  });
}

function cacheState(metadata: ReturnType<typeof syncMetadata>) {
  const accepted = new Set(Object.values(metadata.acceptedGenerationIds));
  const revisions = Object.values(metadata.baseRevisions);
  return {
    state: metadata.lastPull === null ? ("empty" as const) : ("fresh" as const),
    asOf: metadata.lastPull,
    message: null,
    acceptedGenerationId:
      accepted.size === 1 ? (accepted.values().next().value ?? null) : null,
    baseRevision: revisions.length === 0 ? 0 : Math.max(...revisions),
  };
}

/** Registers the four WP-17 sync RPC surfaces through one frozen sub-contract. */
export function registerSyncRpc(
  bb: BbPluginApi,
  deps: EngineDeps,
  assuranceStudio: AssuranceStudioClient | null = null,
  platform: Pick<PlatformClient, "listProjects" | "listVersions"> | null = null,
): void {
  bb.rpc.register(syncScopeCatalogContract, {
    async syncCachedScopes(input) {
      await bb.sdk.projects.get({ projectId: input.workspaceProjectId });
      backfillUnambiguousWorkspaceProjectBinding(
        deps.db,
        input.workspaceProjectId,
      );
      const rows = deps.db
        .prepare<
          [string],
          { project_id: string; project_version_id: string; stale: number }
        >(
          `SELECT project_id, project_version_id,
                  MAX(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS stale
             FROM sync_state s
            WHERE ${WORKSPACE_PLATFORM_PROJECT_PREDICATE}
              AND s.accepted_generation_id IS NOT NULL
              AND s.project_version_id != '@project'
            GROUP BY s.project_id, s.project_version_id
            ORDER BY MAX(s.last_pull) DESC, s.project_id, s.project_version_id`,
        )
        .all(input.workspaceProjectId);
      return {
        scopes: rows.map((row) => ({
          platformProjectId: row.project_id,
          platformProjectName: null,
          projectVersionId: row.project_version_id,
          projectVersionName: null,
          state: row.stale === 1 ? ("stale" as const) : ("fresh" as const),
        })),
      };
    },
    async syncPlatformScopeNames(input) {
      if (!platform) return { scopes: [] };
      return {
        scopes: await resolvePlatformScopeNames(platform, input.scopes),
      };
    },
  });
  bb.rpc.register(syncContract, {
    async syncAsProjectCandidates(input) {
      assertRemoteSyncScope(input.projectId);
      if (!assuranceStudio) throw new Error("Assurance Studio is unavailable");
      await bb.sdk.projects.get({ projectId: input.workspaceProjectId });
      const items = await enumerateAssuranceStudioProjectCandidates(
        assuranceStudio,
        input.projectId,
      );
      return {
        platformProjectId: input.projectId,
        candidateState: assuranceStudioProjectCandidateState(items),
        selectedAssuranceStudioProjectId: selectedAssuranceStudioProject(
          deps,
          input.workspaceProjectId,
          input.projectId,
        ),
        items,
      };
    },
    async syncAsProjectSelect(input) {
      assertRemoteSyncScope(input.projectId);
      if (!assuranceStudio) throw new Error("Assurance Studio is unavailable");
      await bb.sdk.projects.get({ projectId: input.workspaceProjectId });
      return await selectAssuranceStudioProject(deps, assuranceStudio, {
        workspaceProjectId: input.workspaceProjectId,
        platformProjectId: input.projectId,
        assuranceStudioProjectId: input.assuranceStudioProjectId,
      });
    },
    async syncPull(input) {
      await bb.sdk.projects.get({ projectId: input.workspaceProjectId });
      const kinds = entityKinds(input.kinds);
      const scope = {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
      };
      const report = await pullIsolated(deps, scope, kinds, {
        assuranceStudioProjectId: selectedAssuranceStudioProject(
          deps,
          input.workspaceProjectId,
          scope.projectId,
        ),
      });
      const { remoteDiagnostics: _remoteDiagnostics, ...contractReport } =
        report;
      bindWorkspacePlatformProject(
        deps.db,
        input.workspaceProjectId,
        scope.projectId,
      );
      const metadata = syncMetadata(deps, scope, kinds);
      return {
        ...scope,
        ...contractReport,
        baseStateSha256: metadata.baseStateSha256,
      };
    },
    async syncStatus(input) {
      if (input.workspaceProjectId) {
        await bb.sdk.projects.get({ projectId: input.workspaceProjectId });
      }
      const kinds = entityKinds(input.kinds);
      const scope = {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
      };
      let report: Awaited<ReturnType<typeof status>>;
      try {
        report = await status(deps, scope, kinds, {
          assuranceStudioProjectId: input.workspaceProjectId
            ? selectedAssuranceStudioProject(
                deps,
                input.workspaceProjectId,
                scope.projectId,
              )
            : null,
        });
      } catch (error: unknown) {
        const diagnostic = diagnoseRemoteFailure(error);
        if (diagnostic.service !== null) {
          const code = `SYNC_REMOTE_${diagnostic.kind.replaceAll("-", "_").toUpperCase()}`;
          throw new Error(`${code}: ${connectionStatusMessage(diagnostic)}`);
        }
        throw error;
      }
      const metadata = syncMetadata(deps, scope, kinds);
      const scopedChange = (
        change: { kind: EntityKind; key: string; fields: string[] },
        artifactId: string | null,
      ) => ({
        ...scope,
        kind: change.kind,
        key: change.key,
        fields: change.fields,
        artifactId,
      });
      return {
        ...scope,
        acceptedGenerationIds: metadata.acceptedGenerationIds,
        stagingGenerationIds: metadata.stagingGenerationIds,
        baseRevisions: metadata.baseRevisions,
        baseStateSha256: metadata.baseStateSha256,
        local: report.local.map((change) => scopedChange(change, null)),
        upstream: report.upstream.map((change) => scopedChange(change, null)),
        conflicts: report.conflicts.map((change) =>
          scopedChange({ ...change, fields: [] }, null),
        ),
        orphans: report.orphans.map((change) =>
          scopedChange({ ...change, fields: [] }, change.file),
        ),
        cache: cacheState(metadata),
      };
    },
    async syncPlan(input) {
      if (input.workspaceProjectId) {
        await bb.sdk.projects.get({ projectId: input.workspaceProjectId });
      }
      return plan(deps, {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
        kinds: entityKinds(input.kinds),
        pageSize: input.pageSize,
        continuation: input.continuation,
        binding: {
          assuranceStudioProjectId: input.workspaceProjectId
            ? selectedAssuranceStudioProject(
                deps,
                input.workspaceProjectId,
                input.projectId,
              )
            : null,
        },
      });
    },
    syncConflictResolve: (input) => resolveConflictRpc(deps, input),
    syncPush: (input) =>
      pushAuthorizationUnavailable(deps, input.humanApprovalCapability),
    syncPushRetry: (input) =>
      pushAuthorizationUnavailable(deps, input.humanApprovalCapability),
  });
}
