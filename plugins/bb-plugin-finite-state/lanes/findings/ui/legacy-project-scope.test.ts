import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { REPO_LOCAL_PROJECT_ID_PREFIX } from "../../../lib/contract-load/projection-key.js";
import { createPluginContext } from "../../../lib/context.js";
import { registerFindingsRpc } from "../rpc.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () =>
  Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose())),
);

describe("legacy cached-project scope", () => {
  it("does not spend one-shot backfill on a loader-seeded repo-local scope", async () => {
    const host = createFakePluginHost({
      pluginId: "findings-repo-local-backfill-preserve",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
      },
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const repoLocalProjectId = `${REPO_LOCAL_PROJECT_ID_PREFIX}abc123digest`;
    const repoLocalVersionId = "fs-local-checkout:abc123digest";
    const bindings = () =>
      db
        .prepare(
          `SELECT workspace_project_id, platform_project_id
             FROM workspace_platform_project_binding
            ORDER BY workspace_project_id, platform_project_id`,
        )
        .all();

    // Fresh offline state after WP-99 loader: only the synthetic scope exists.
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
    registerFindingsRpc(host.bb, db);

    await expect(
      host.harness.callRpc("cachedProjectVersions", {
        projectId: "workspace-after-loader",
      }),
    ).resolves.toMatchObject({ versions: [] });
    expect(bindings()).toEqual([]);

    // Later: a genuine single Platform project lands in the same store.
    db.prepare(
      `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES ('platform-project-later', 'platform-version-later',
               'platform-generation-later', 'accepted', '["finding"]',
               ?, ?, ?)`,
    ).run(
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        last_pull)
       VALUES ('platform-project-later', 'platform-version-later', 'finding',
               'platform-generation-later', '2026-08-14T01:00:00.000Z')`,
    ).run();

    await expect(
      host.harness.callRpc("cachedProjectVersions", {
        projectId: "workspace-after-platform",
      }),
    ).resolves.toMatchObject({
      versions: [
        {
          platformProjectId: "platform-project-later",
          projectVersionId: "platform-version-later",
        },
      ],
    });
    expect(bindings()).toEqual([
      {
        workspace_project_id: "workspace-after-platform",
        platform_project_id: "platform-project-later",
      },
    ]);
  });

  it("still backfills a Platform project when a prior repo-local binding exists", async () => {
    const host = createFakePluginHost({
      pluginId: "findings-repo-local-binding-does-not-spend",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
      },
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const repoLocalProjectId = `${REPO_LOCAL_PROJECT_ID_PREFIX}alreadybound`;
    db.prepare(
      `INSERT INTO workspace_platform_project_binding
       (workspace_project_id, platform_project_id)
       VALUES ('workspace-pre-fix', ?)`,
    ).run(repoLocalProjectId);
    db.prepare(
      `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES (?, 'fs-local-checkout:alreadybound', 'repo-local-generation',
               'accepted', '["requirement"]', ?, ?, ?),
              ('platform-project-only', 'platform-version-only',
               'platform-generation-only', 'accepted', '["finding"]',
               ?, ?, ?)`,
    ).run(
      repoLocalProjectId,
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        last_pull)
       VALUES (?, 'fs-local-checkout:alreadybound', 'requirement',
               'repo-local-generation', '2026-08-14T00:00:00.000Z'),
              ('platform-project-only', 'platform-version-only', 'finding',
               'platform-generation-only', '2026-08-14T01:00:00.000Z')`,
    ).run(repoLocalProjectId);
    registerFindingsRpc(host.bb, db);

    await expect(
      host.harness.callRpc("cachedProjectVersions", {
        projectId: "workspace-after-upgrade",
      }),
    ).resolves.toMatchObject({
      versions: [
        {
          platformProjectId: "platform-project-only",
          projectVersionId: "platform-version-only",
        },
      ],
    });
    expect(
      db
        .prepare(
          `SELECT workspace_project_id, platform_project_id
             FROM workspace_platform_project_binding
            ORDER BY workspace_project_id, platform_project_id`,
        )
        .all(),
    ).toEqual([
      {
        workspace_project_id: "workspace-after-upgrade",
        platform_project_id: "platform-project-only",
      },
      {
        workspace_project_id: "workspace-pre-fix",
        platform_project_id: repoLocalProjectId,
      },
    ]);
  });

  it("does not bind when a synthetic scope sits beside two Platform projects", async () => {
    const host = createFakePluginHost({
      pluginId: "findings-synthetic-plus-two-platform-no-bind",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
      },
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const repoLocalProjectId = `${REPO_LOCAL_PROJECT_ID_PREFIX}twosided`;
    db.prepare(
      `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES (?, 'fs-local-checkout:twosided', 'repo-local-generation',
               'accepted', '["requirement"]', ?, ?, ?),
              ('platform-a', 'version-a', 'generation-a', 'accepted',
               '["finding"]', ?, ?, ?),
              ('platform-b', 'version-b', 'generation-b', 'accepted',
               '["finding"]', ?, ?, ?)`,
    ).run(
      repoLocalProjectId,
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T02:00:00.000Z",
      "2026-08-14T02:00:00.000Z",
      "2026-08-14T02:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        last_pull)
       VALUES (?, 'fs-local-checkout:twosided', 'requirement',
               'repo-local-generation', '2026-08-14T00:00:00.000Z'),
              ('platform-a', 'version-a', 'finding', 'generation-a',
               '2026-08-14T01:00:00.000Z'),
              ('platform-b', 'version-b', 'finding', 'generation-b',
               '2026-08-14T02:00:00.000Z')`,
    ).run(repoLocalProjectId);
    registerFindingsRpc(host.bb, db);

    await expect(
      host.harness.callRpc("cachedProjectVersions", {
        projectId: "workspace-ambiguous",
      }),
    ).resolves.toMatchObject({
      versions: [
        {
          platformProjectId: "platform-b",
          projectVersionId: "version-b",
        },
        {
          platformProjectId: "platform-a",
          projectVersionId: "version-a",
        },
      ],
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM workspace_platform_project_binding`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("leaves a pre-existing Platform binding untouched", async () => {
    const host = createFakePluginHost({
      pluginId: "findings-existing-platform-binding-untouched",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
      },
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const repoLocalProjectId = `${REPO_LOCAL_PROJECT_ID_PREFIX}with-prior`;
    db.prepare(
      `INSERT INTO workspace_platform_project_binding
       (workspace_project_id, platform_project_id)
       VALUES ('workspace-already-bound', 'platform-already-bound')`,
    ).run();
    db.prepare(
      `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES (?, 'fs-local-checkout:with-prior', 'repo-local-generation',
               'accepted', '["requirement"]', ?, ?, ?),
              ('platform-candidate', 'version-candidate',
               'generation-candidate', 'accepted', '["finding"]', ?, ?, ?)`,
    ).run(
      repoLocalProjectId,
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
      "2026-08-14T01:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        last_pull)
       VALUES (?, 'fs-local-checkout:with-prior', 'requirement',
               'repo-local-generation', '2026-08-14T00:00:00.000Z'),
              ('platform-candidate', 'version-candidate', 'finding',
               'generation-candidate', '2026-08-14T01:00:00.000Z')`,
    ).run(repoLocalProjectId);
    registerFindingsRpc(host.bb, db);

    await expect(
      host.harness.callRpc("cachedProjectVersions", {
        projectId: "workspace-new-opener",
      }),
    ).resolves.toMatchObject({
      versions: [
        {
          platformProjectId: "platform-candidate",
          projectVersionId: "version-candidate",
        },
      ],
    });
    expect(
      db
        .prepare(
          `SELECT workspace_project_id, platform_project_id
             FROM workspace_platform_project_binding
            ORDER BY workspace_project_id, platform_project_id`,
        )
        .all(),
    ).toEqual([
      {
        workspace_project_id: "workspace-already-bound",
        platform_project_id: "platform-already-bound",
      },
    ]);
  });

  it("keeps a two-project unbound store visible without inventing a binding", async () => {
    const host = createFakePluginHost({
      pluginId: "findings-legacy-multi-project-scope",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
      },
    });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    db.prepare(
      `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES ('legacy-platform-a', 'legacy-version-a', 'legacy-generation-a',
               'accepted', '["finding"]', ?, ?, ?),
              ('legacy-platform-b', 'legacy-version-b', 'legacy-generation-b',
               'accepted', '["finding"]', ?, ?, ?)`,
    ).run(
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T01:00:00.000Z",
      "2026-08-12T01:00:00.000Z",
      "2026-08-12T01:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        last_pull)
       VALUES ('legacy-platform-a', 'legacy-version-a', 'finding',
               'legacy-generation-a', '2026-08-12T00:00:00.000Z'),
              ('legacy-platform-b', 'legacy-version-b', 'finding',
               'legacy-generation-b', '2026-08-12T01:00:00.000Z')`,
    ).run();
    registerFindingsRpc(host.bb, db);

    const readVersions = async (workspaceProjectId: string) => {
      const result = await host.harness.callRpc("cachedProjectVersions", {
        projectId: workspaceProjectId,
      });
      if (
        typeof result !== "object" ||
        result === null ||
        !("versions" in result) ||
        !Array.isArray(result.versions)
      ) {
        throw new Error("cachedProjectVersions returned an invalid result");
      }
      return result.versions.map((version) => {
        if (
          typeof version !== "object" ||
          version === null ||
          !("platformProjectId" in version)
        ) {
          throw new Error("cachedProjectVersions returned an invalid version");
        }
        return version.platformProjectId;
      });
    };
    const bindings = () =>
      db
        .prepare(
          `SELECT workspace_project_id, platform_project_id
             FROM workspace_platform_project_binding
            ORDER BY workspace_project_id, platform_project_id`,
        )
        .all();

    await expect(readVersions("legacy-workspace-a")).resolves.toEqual([
      "legacy-platform-b",
      "legacy-platform-a",
    ]);
    expect(bindings()).toEqual([]);
    await expect(readVersions("legacy-workspace-b")).resolves.toEqual([
      "legacy-platform-b",
      "legacy-platform-a",
    ]);
    expect(bindings()).toEqual([]);

    db.prepare(
      `INSERT INTO workspace_platform_project_binding
       (workspace_project_id, platform_project_id)
       VALUES ('existing-workspace', 'existing-platform')`,
    ).run();
    db.prepare(
      `DELETE FROM sync_state
        WHERE project_id = 'legacy-platform-b'`,
    ).run();

    await expect(readVersions("legacy-workspace-c")).resolves.toEqual([
      "legacy-platform-a",
    ]);
    expect(bindings()).toEqual([
      {
        workspace_project_id: "existing-workspace",
        platform_project_id: "existing-platform",
      },
    ]);
  });
});
