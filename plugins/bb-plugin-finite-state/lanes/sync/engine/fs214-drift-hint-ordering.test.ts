import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../../lib/context.js";
import { FINDINGS_DRIFT_CHANGED_CHANNEL } from "../../findings/drift/report.js";
import { registerFindingsDrift } from "../../findings/drift/index.js";
import { registerSyncRpc } from "../rpc.js";
import { emitAcceptedPullHints } from "../register.js";
import {
  registerCachePuller,
  registeredCachePullers,
  type CachePuller,
} from "./adapter.js";
import { type EngineDeps } from "./pull.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
let previousFindingPuller: CachePuller | undefined;

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  if (previousFindingPuller !== undefined) {
    registerCachePuller("finding", previousFindingPuller);
    previousFindingPuller = undefined;
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("FS-214 findings drift hint vs accepted-pointer flip", () => {
  it("emits fs-findings-drift-changed only after the accepted pointer flips for a published finding", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-fs214-hint-lock",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              {
                id: "source-1",
                projectId,
                type: "local_path" satisfies "local_path",
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
    previousFindingPuller = registeredCachePullers().find(
      (candidate) => candidate.kind === "finding",
    )?.pull;

    let reportBaseRows = 99;
    registerCachePuller("finding", async (scope, generationId) => {
      db.prepare(
        `UPDATE sync_state
            SET staged_pages = 1, staged_rows = 1, staged_quarantined = 0
          WHERE project_id = ? AND project_version_id = ?
            AND entity_kind = 'finding'
            AND staging_generation_id = ?`,
      ).run(scope.projectId, scope.projectVersionId, generationId);
      return {
        fetched: 1,
        baseRows: reportBaseRows,
        quarantined: 0,
        advisories: [],
      };
    });
    registerFindingsDrift(ctx);

    let currentProjectId = "";
    const acceptedAtHint: Array<string | null> = [];
    const driftPayloads: unknown[] = [];
    const originalPublish = host.bb.realtime.publish.bind(host.bb.realtime);
    host.bb.realtime.publish = (channel, payload) => {
      if (channel === FINDINGS_DRIFT_CHANGED_CHANNEL) {
        const pvId =
          isRecord(payload) && typeof payload["pvId"] === "string"
            ? payload["pvId"]
            : null;
        const accepted = db
          .prepare(
            `SELECT accepted_generation_id
             FROM sync_state
            WHERE project_id = ? AND project_version_id = ?
              AND entity_kind = 'finding'`,
          )
          .pluck()
          .get(currentProjectId, pvId);
        acceptedAtHint.push(typeof accepted === "string" ? accepted : null);
        driftPayloads.push(payload);
      }
      originalPublish(channel, payload);
    };

    let generation = 0;
    const deps: EngineDeps = {
      db,
      worktreeRoot: null,
      adapters: [],
      createGenerationId: () => `fs214-lock-${++generation}`,
      now: () => new Date("2026-08-15T06:22:00.000Z"),
      publish: (channel, progress) =>
        host.bb.realtime.publish(channel, progress),
      published: (publication) =>
        emitAcceptedPullHints(host.bb.realtime.publish, publication),
    };
    registerSyncRpc(host.bb, deps);

    const failedScope = {
      projectId: "project-fs214-fail",
      projectVersionId: "v-fail",
    };
    currentProjectId = failedScope.projectId;
    reportBaseRows = 99;
    const failed = await host.harness.behavior.callRpc("syncPull", {
      workspaceProjectId: "bb-project-fs214",
      ...failedScope,
      kinds: ["finding"],
    });
    expect(failed).toMatchObject({
      kinds: {
        finding: {
          status: "failed",
          acceptedAt: null,
        },
      },
    });
    expect(driftPayloads).toEqual([]);
    expect(acceptedAtHint).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT accepted_generation_id
           FROM sync_state
          WHERE project_id = ? AND project_version_id = ?
            AND entity_kind = 'finding'`,
        )
        .pluck()
        .get(failedScope.projectId, failedScope.projectVersionId),
    ).toBeNull();

    const publishedScope = {
      projectId: "project-fs214-ok",
      projectVersionId: "v-ok",
    };
    currentProjectId = publishedScope.projectId;
    reportBaseRows = 1;
    const published = await host.harness.behavior.callRpc("syncPull", {
      workspaceProjectId: "bb-project-fs214",
      ...publishedScope,
      kinds: ["finding"],
    });
    expect(published).toMatchObject({
      kinds: {
        finding: {
          status: "published",
          generationId: "fs214-lock-2",
        },
      },
    });
    expect(driftPayloads).toEqual([{ pvId: publishedScope.projectVersionId }]);
    expect(acceptedAtHint).toEqual(["fs214-lock-2"]);
  });
});
