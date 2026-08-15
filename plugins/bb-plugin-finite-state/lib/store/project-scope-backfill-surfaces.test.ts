import type { BbPluginApi } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { registerBench } from "../../lanes/bench/register.js";
import { registerBom } from "../../lanes/bom/register.js";
import { registerFindingsRpc } from "../../lanes/findings/rpc.js";
import { REPO_LOCAL_PROJECT_ID_PREFIX } from "../contract-load/projection-key.js";
import { createPluginContext, type PluginContext } from "../context.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () =>
  Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose())),
);

const SURFACES = [
  {
    rpc: "cachedProjectVersions",
    platformEntityKind: "finding",
    register(bb: BbPluginApi, ctx: PluginContext): void {
      registerFindingsRpc(bb, ctx.db());
    },
  },
  {
    rpc: "benchProjectVersions",
    platformEntityKind: "verificationRun",
    register(bb: BbPluginApi, ctx: PluginContext): void {
      registerBench(bb, ctx);
    },
  },
  {
    rpc: "bomCachedProjectVersions",
    platformEntityKind: "sbomComponent",
    register(bb: BbPluginApi, ctx: PluginContext): void {
      registerBom(bb, ctx);
    },
  },
] as const;

describe("repo-local one-shot backfill — registered surfaces", () => {
  it.each(SURFACES)(
    "$rpc preserves the one-shot for a later Platform project",
    async ({ rpc, platformEntityKind, register }) => {
      const host = createFakePluginHost({
        pluginId: `backfill-surface-${rpc}`,
        sdk: {
          projects: {
            get: ({ projectId }) => ({
              id: projectId,
              kind: "standard" as const,
              name: projectId,
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [
                {
                  id: `source-${projectId}`,
                  projectId,
                  type: "local_path" as const,
                  hostId: "host-1",
                  path: "/workspace",
                  isDefault: true,
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            }),
          },
        },
      });
      hosts.push(host);
      const ctx = createPluginContext(host.bb);
      const db = ctx.db();
      register(host.bb, ctx);

      const repoLocalProjectId = `${REPO_LOCAL_PROJECT_ID_PREFIX}${rpc}-digest`;
      const repoLocalVersionId = `fs-local-checkout:${rpc}-digest`;
      const bindings = () =>
        db
          .prepare(
            `SELECT workspace_project_id, platform_project_id
               FROM workspace_platform_project_binding
              ORDER BY workspace_project_id, platform_project_id`,
          )
          .all();

      db.prepare(
        `INSERT INTO pull_generation
         (project_id, project_version_id, generation_id, status,
          requested_kinds_json, started_at, completed_at, accepted_at)
         VALUES (?, ?, 'repo-local-generation', 'accepted', '["requirement"]',
                 ?, ?, ?)`,
      ).run(
        repoLocalProjectId,
        repoLocalVersionId,
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO sync_state
         (project_id, project_version_id, entity_kind, accepted_generation_id,
          last_pull)
         VALUES (?, ?, 'requirement', 'repo-local-generation',
                 '2026-08-14T00:00:00.000Z')`,
      ).run(repoLocalProjectId, repoLocalVersionId);

      await host.harness.behavior.callRpc(rpc, {
        projectId: "workspace-after-loader",
      });
      expect(bindings()).toEqual([]);

      db.prepare(
        `INSERT INTO pull_generation
         (project_id, project_version_id, generation_id, status,
          requested_kinds_json, started_at, completed_at, accepted_at)
         VALUES ('platform-project-later', 'platform-version-later',
                 'platform-generation-later', 'accepted', ?, ?, ?, ?)`,
      ).run(
        JSON.stringify([platformEntityKind]),
        "2026-08-14T01:00:00.000Z",
        "2026-08-14T01:00:00.000Z",
        "2026-08-14T01:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO sync_state
         (project_id, project_version_id, entity_kind, accepted_generation_id,
          last_pull)
         VALUES ('platform-project-later', 'platform-version-later', ?,
                 'platform-generation-later', '2026-08-14T01:00:00.000Z')`,
      ).run(platformEntityKind);

      await host.harness.behavior.callRpc(rpc, {
        projectId: "workspace-after-platform",
      });
      expect(bindings()).toEqual([
        {
          workspace_project_id: "workspace-after-platform",
          platform_project_id: "platform-project-later",
        },
      ]);
    },
  );
});
