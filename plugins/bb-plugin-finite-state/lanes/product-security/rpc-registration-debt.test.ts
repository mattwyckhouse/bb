import { createHash } from "node:crypto";

import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../lib/context.js";
import { rpcContract } from "../../shared/contract.js";
import { registerProductSecurity } from "./register.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

describe("FS-220 Product Security frozen registrations", () => {
  it("registers taraGet over the accepted cache and reviewTransition fail-closed", async () => {
    const host = createFakePluginHost({
      pluginId: "fs220-product-security-rpcs",
      sdk: {
        projects: {
          get: () => {
            throw new Error("No local source is mounted for this cache read");
          },
        },
      },
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    const db = ctx.db();
    const projectId = "platform-project";
    const projectVersionId = "version-1";
    const generationId = "generation-1";
    const pulledAt = "2026-08-14T12:00:00.000Z";
    const payload = JSON.stringify({
      slug: "threat-1",
      name: "Unsigned boot path",
      category: "spoofing",
    });
    db.prepare(
      `INSERT INTO pull_generation
        (project_id, project_version_id, generation_id, status,
         requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES (?, ?, ?, 'accepted', '["threat"]', ?, ?, ?)`,
    ).run(
      projectId,
      projectVersionId,
      generationId,
      pulledAt,
      pulledAt,
      pulledAt,
    );
    db.prepare(
      `INSERT INTO sync_state
        (project_id, project_version_id, entity_kind, accepted_generation_id,
         base_revision, last_pull)
       VALUES (?, ?, 'threat', ?, 3, ?)`,
    ).run(projectId, projectVersionId, generationId, pulledAt);
    db.prepare(
      `INSERT INTO base_snapshot
        (project_id, project_version_id, entity_kind, generation_id,
         entity_key, remote_id, payload, content_hash, pulled_at)
       VALUES (?, ?, 'threat', ?, 'remote-threat-1', 'remote-threat-1', ?, ?, ?)`,
    ).run(
      projectId,
      projectVersionId,
      generationId,
      payload,
      createHash("sha256").update(payload).digest("hex"),
      pulledAt,
    );
    registerProductSecurity(host.bb, ctx);

    const threat = rpcContract.taraGet.output.parse(
      await host.harness.behavior.callRpc("taraGet", {
        projectId,
        projectVersionId,
        kind: "threat",
        id: "threat-1",
      }),
    );
    expect(threat).toEqual({
      projectId,
      projectVersionId,
      kind: "threat",
      key: "threat-1",
      label: "Unsigned boot path",
      fields: {
        slug: "threat-1",
        name: "Unsigned boot path",
        category: "spoofing",
      },
      links: [],
      cache: {
        state: "fresh",
        asOf: pulledAt,
        message: null,
        acceptedGenerationId: generationId,
        baseRevision: 3,
      },
    });

    const changesBefore = db.prepare("SELECT total_changes() AS count").get();
    await expect(
      host.harness.behavior.callRpc("reviewTransition", {
        projectId,
        projectVersionId,
        humanApprovalCapability: "caller-supplied-token-is-not-approval",
        entityKind: "threat",
        entityId: "threat-1",
        operationId: "review-operation-1",
        entitySnapshotSha256: "a".repeat(64),
        expectedReviewVersion: "1",
        action: "approve",
      }),
    ).rejects.toThrow("authorization-unavailable");
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(
      changesBefore,
    );
    expect(host.harness.inspection.registrations.rpcMethods).toEqual(
      expect.arrayContaining(["taraGet", "reviewTransition"]),
    );
    expect(host.harness.inspection.registrations.agentTools).toEqual([]);
  });
});
