import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../../../lib/context.js";
import { AssuranceStudioClient } from "../../../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../../../lib/remote/platform/client.js";
import type { AsEntity, RemoteServices } from "../../../../lib/remote/types.js";
import { createMockPlatformState } from "../../../../test/mock-remote/platform/state.js";
import { registerPlatformHandlers } from "../../../../test/mock-remote/platform/register.js";
import { registerMockAssuranceStudio } from "../../../../test/mock-remote/assurance-studio/register.js";
import { createMockRemote } from "../../../../test/mock-remote/server.js";
import { registerBench } from "../../../bench/register.js";
import { registerSync } from "../../../sync/register.js";
import { registerProductSecurity } from "../../register.js";

const FIXTURE_ROOT = resolve(
  import.meta.dirname,
  "../../../../test/mock-remote/fixtures",
);
const WORKSPACE_PROJECT_ID = "workspace-fs201";
const THREAD_ID = "thread-fs201";
const ENVIRONMENT_ID = "environment-fs201";
const HOST_ID = "host-fs201";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function requiredId(
  row: Record<string, unknown> | undefined,
  label: string,
): string {
  const id = row?.["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} has no id`);
  }
  return id;
}

describe("registered requirement-to-bench journey", () => {
  it("pulls, enables the bench, starts a run, renders a verdict result, and preserves the prior acceptance on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs201-requirement-bench-"));
    roots.push(root);
    const host = createFakePluginHost({
      pluginId: "finite-state-fs201",
      sdk: {
        projects: {
          get: async ({ projectId }) => ({
            id: projectId,
            kind: "standard" as const,
            name: "FS-201",
            gitRemoteUrl: null,
            createdAt: 1,
            updatedAt: 1,
            sources: [
              {
                id: "source-fs201",
                projectId,
                type: "local_path" as const,
                hostId: HOST_ID,
                path: root,
                isDefault: true,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }),
        },
        threads: {
          get: async () =>
            makeThreadResponse({
              id: THREAD_ID,
              projectId: WORKSPACE_PROJECT_ID,
              environmentId: ENVIRONMENT_ID,
            }),
          spawn: async () => ({ id: "bench-thread-fs201" }),
        },
        environments: {
          get: async () => ({
            id: ENVIRONMENT_ID,
            projectId: WORKSPACE_PROJECT_ID,
            path: root,
            hostId: HOST_ID,
          }),
        },
        hosts: {
          list: async () => [
            {
              id: HOST_ID,
              name: "FS-201 bench host",
              type: "persistent" as const,
              status: "connected" as const,
              maxPermissionMode: "full" as const,
              lastSeenAt: 1,
              lastRejectedProtocolVersion: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
    });
    const platformState = createMockPlatformState(FIXTURE_ROOT);
    const mock = createMockRemote({
      platformToken: "fs201-platform-token",
      assuranceStudioKey: "fs201-as-key",
      fixtureRoot: FIXTURE_ROOT,
      register(service, registry) {
        if (service === "platform") {
          registerPlatformHandlers(registry, platformState);
        } else {
          registerMockAssuranceStudio(registry, FIXTURE_ROOT);
        }
      },
    });
    const platform = new PlatformClient({
      baseUrl: "http://platform.mock",
      token: "fs201-platform-token",
      fetch: mock.platform.fetch,
    });
    const assuranceStudio = new AssuranceStudioClient({
      baseUrl: "http://assurance-studio.mock",
      apiKey: "fs201-as-key",
      fetch: mock.assuranceStudio.fetch,
    });
    try {
      const ctx = createPluginContext(host.bb);
      const services: RemoteServices = {
        platform,
        assuranceStudio,
        forgeCompute: null,
      };
      ctx.service<RemoteServices>("remote-services", () => services);
      registerBench(host.bb, ctx);
      registerSync(host.bb, ctx);
      registerProductSecurity(host.bb, ctx);

      const platformProjectId = requiredId(
        [...platformState.projects.values()][0],
        "project fixture",
      );
      const projectVersionId = requiredId(
        [...platformState.versions.values()][0],
        "version fixture",
      );

      await expect(
        host.harness.behavior.callRpc("benchProjectVersions", {
          projectId: WORKSPACE_PROJECT_ID,
        }),
      ).resolves.toMatchObject({ versions: [] });

      const pulled = await host.harness.behavior.runCli(
        [
          "finite-state",
          "pull",
          "requirement",
          "--project",
          platformProjectId,
          "--version",
          projectVersionId,
          "--json",
        ],
        { projectId: WORKSPACE_PROJECT_ID, threadId: THREAD_ID },
      );
      expect(pulled).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(pulled.stdout)).toMatchObject({
        kinds: {
          requirement: { fetched: 40, baseRows: 40, quarantined: 0 },
        },
      });

      const versions = await host.harness.behavior.callRpc(
        "benchProjectVersions",
        { projectId: WORKSPACE_PROJECT_ID },
      );
      expect(versions).toMatchObject({
        selectedPlatformProjectId: platformProjectId,
        selectedProjectVersionId: projectVersionId,
        versions: [
          {
            platformProjectId,
            projectVersionId,
            state: "fresh",
          },
        ],
      });

      const acceptedGeneration = ctx
        .db()
        .prepare<[string, string], { accepted_generation_id: string }>(
          `SELECT accepted_generation_id
             FROM sync_state
            WHERE project_id = ? AND project_version_id = ?
              AND entity_kind = 'requirement'`,
        )
        .get(platformProjectId, projectVersionId)!.accepted_generation_id;
      ctx
        .db()
        .prepare(
          `INSERT INTO firmware_mounts
           (project_id, project_version_id, generation_id, source, state,
            input_sha256, artifact_hash, root_path, file_count,
            materialized_files, error_count, pulled_at)
           VALUES (?, ?, ?, 'standalone_unpack', 'metadata_only', ?, NULL, ?,
                   0, 0, 0, '2026-08-14T12:00:00.000Z')`,
        )
        .run(
          platformProjectId,
          projectVersionId,
          acceptedGeneration,
          "a".repeat(64),
          root,
        );

      const started = await host.harness.behavior.callRpc(
        "benchRunAttemptStart",
        {
          projectId: platformProjectId,
          projectVersionId,
          tier: "tier0",
          hostId: HOST_ID,
        },
      );
      expect(started).toMatchObject({
        success: true,
        run: { projectId: platformProjectId, projectVersionId },
      });
      const verdict = await host.harness.behavior.callRpc(
        "benchOtaVerdictGet",
        { projectId: platformProjectId, pvId: projectVersionId },
      );
      expect(verdict).toMatchObject({
        pvId: projectVersionId,
        verdict: "INCONCLUSIVE",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "MODEL_UNAVAILABLE" }),
        ]),
      });

      const originalListEntities =
        assuranceStudio.listEntities.bind(assuranceStudio);
      assuranceStudio.listEntities = (kind, input, callContext) => ({
        async *[Symbol.asyncIterator]() {
          for await (const page of originalListEntities(
            kind,
            input,
            callContext,
          )) {
            yield page;
            throw new Error("induced requirement page failure");
          }
        },
      });
      const failed = await host.harness.behavior.runCli(
        [
          "finite-state",
          "pull",
          "requirement",
          "--project",
          platformProjectId,
          "--version",
          projectVersionId,
        ],
        { projectId: WORKSPACE_PROJECT_ID, threadId: THREAD_ID },
      );
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain("induced requirement page failure");
      expect(
        ctx
          .db()
          .prepare<[string, string], { accepted_generation_id: string }>(
            `SELECT accepted_generation_id
               FROM sync_state
              WHERE project_id = ? AND project_version_id = ?
                AND entity_kind = 'requirement'`,
          )
          .get(platformProjectId, projectVersionId)!.accepted_generation_id,
      ).toBe(acceptedGeneration);
      await expect(
        host.harness.behavior.callRpc("benchProjectVersions", {
          projectId: WORKSPACE_PROJECT_ID,
        }),
      ).resolves.toMatchObject({
        versions: [expect.objectContaining({ state: "stale" })],
      });

      assuranceStudio.listEntities = () => ({
        async *[Symbol.asyncIterator]() {
          yield { items: [] as AsEntity[], total: 0, next: null };
        },
      });
      const emptyVersion = "empty-requirements-version";
      const empty = await host.harness.behavior.runCli(
        [
          "finite-state",
          "pull",
          "requirement",
          "--project",
          platformProjectId,
          "--version",
          emptyVersion,
          "--json",
        ],
        { projectId: WORKSPACE_PROJECT_ID, threadId: THREAD_ID },
      );
      expect(empty).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(empty.stdout)).toMatchObject({
        kinds: {
          requirement: { fetched: 0, baseRows: 0, quarantined: 0 },
        },
      });
      await expect(
        host.harness.behavior.callRpc("benchProjectVersions", {
          projectId: WORKSPACE_PROJECT_ID,
        }),
      ).resolves.toMatchObject({
        versions: expect.arrayContaining([
          expect.objectContaining({ projectVersionId: emptyVersion }),
        ]),
      });
    } finally {
      platform.close();
      assuranceStudio.close();
      await mock.close();
      await host.harness.lifecycle.dispose();
    }
  });
});
