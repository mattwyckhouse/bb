import { createHash } from "node:crypto";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "../../../../lib/context.js";
import { ENTITIES } from "../../../../lib/sync/registry.js";
import { rpcContract } from "../../../../shared/contract.js";
import { registerCanvasEditingBackend } from "./backend.js";
import {
  architectureEntityPayload,
  canvasEditingLoadOutputSchema,
  parseArchitectureEntity,
  type ArchitectureYamlEntity,
  type CanvasEntityKind,
} from "./schema.js";
import { serializeCanvasEntity } from "./writer.js";

const PROJECT = "project-read-only";
const VERSION = "@project";
const GENERATION = "generation-read-only";
const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function component(
  slug: string,
  componentType = "software",
): ArchitectureYamlEntity {
  return parseArchitectureEntity("component", {
    slug,
    name: slug,
    component_type: componentType,
    criticality: "high",
    interfaces: [],
    technologies: [],
    is_entry_point: false,
    stores_data: false,
  });
}

function dataflow(
  slug: string,
  from: string,
  to: string,
): ArchitectureYamlEntity {
  return parseArchitectureEntity("dataflow", {
    slug,
    name: slug,
    from,
    to,
    data_types: ["telemetry"],
    encrypted: true,
    authenticated: true,
    bidirectional: false,
  });
}

function seedAccepted(
  context: ReturnType<typeof createPluginContext>,
  entities: readonly ArchitectureYamlEntity[],
): void {
  const kinds = [...new Set(entities.map((entity) => entity.kind))];
  const db = context.db();
  db.prepare(
    `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
     VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)`,
  ).run(
    PROJECT,
    VERSION,
    GENERATION,
    JSON.stringify(kinds),
    "2026-08-13T12:00:00.000Z",
    "2026-08-13T12:00:01.000Z",
    "2026-08-13T12:00:01.000Z",
  );
  const insertSync = db.prepare(
    `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        base_revision, last_pull, error)
     VALUES (?, ?, ?, ?, 1, ?, NULL)`,
  );
  const insertSnapshot = db.prepare(
    `INSERT INTO base_snapshot
       (project_id, project_version_id, entity_kind, generation_id,
        entity_key, remote_id, payload, content_hash, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const kind of kinds) {
    insertSync.run(
      PROJECT,
      VERSION,
      kind,
      GENERATION,
      "2026-08-13T12:00:01.000Z",
    );
  }
  for (const entity of entities) {
    const payload = architectureEntityPayload(entity);
    const encoded = JSON.stringify(payload);
    insertSnapshot.run(
      PROJECT,
      VERSION,
      entity.kind,
      GENERATION,
      ENTITIES[entity.kind].key(payload),
      `remote-${entity.slug}`,
      encoded,
      hash(encoded),
      "2026-08-13T12:00:01.000Z",
    );
  }
}

describe("WP-35 read-classified editing RPCs", () => {
  it("loads accepted entities and computes impact without materializing YAML", async () => {
    const writes = vi.fn(() => {
      throw new Error("read-classified RPC attempted a file write");
    });
    const moves = vi.fn(() => {
      throw new Error("read-classified RPC attempted a file move");
    });
    const removes = vi.fn(() => {
      throw new Error("read-classified RPC attempted a file remove");
    });
    const host = createFakePluginHost({
      pluginId: "finite-state-editing-read-only",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
        files: {
          list: () => ({ files: [], truncated: false }),
          read: ({ path }) => {
            throw Object.assign(new Error(`ENOENT: ${path}`), {
              code: "ENOENT",
            });
          },
          write: writes,
          move: moves,
          remove: removes,
        },
      },
    });
    hosts.push(host);
    const context = createPluginContext(host.bb);
    const gateway = component("gateway");
    seedAccepted(context, [
      gateway,
      component("cloud"),
      dataflow("telemetry", "gateway", "cloud"),
    ]);
    registerCanvasEditingBackend(host.bb, context);

    const loaded = await host.harness.callRpc("canvasEditingLoad", {
      projectId: PROJECT,
      projectVersionId: null,
      kind: "component" as CanvasEntityKind,
      slug: "gateway",
    });
    expect(loaded).toMatchObject({
      state: "ready",
      kind: "component",
      slug: "gateway",
      sha256: hash(serializeCanvasEntity(gateway)),
    });
    const impact = rpcContract.taraDeleteImpact.output.parse(
      await host.harness.callRpc("taraDeleteImpact", {
        projectId: PROJECT,
        projectVersionId: null,
        kind: "component",
        stableKey: "gateway",
      }),
    );
    expect(impact.referrers).toEqual([
      expect.objectContaining({
        kind: "dataflow",
        stableKey: "telemetry",
      }),
    ]);
    expect(writes).not.toHaveBeenCalled();
    expect(moves).not.toHaveBeenCalled();
    expect(removes).not.toHaveBeenCalled();
  });

  it("edits a pulled firmware component through the registered RPC path and preserves its YAML type", async () => {
    const files = new Map<string, string>();
    const host = createFakePluginHost({
      pluginId: "finite-state-editing-firmware",
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
        files: {
          list: ({ path }) => ({
            files: [...files.keys()]
              .filter((candidate) => candidate.startsWith(`${path}/`))
              .map((path) => ({
                path,
                name: path.slice(path.lastIndexOf("/") + 1),
              })),
            truncated: false,
          }),
          read: ({ path }) => {
            const content = files.get(path);
            if (content === undefined) {
              throw Object.assign(new Error(`ENOENT: ${path}`), {
                code: "ENOENT",
              });
            }
            return {
              content,
              contentEncoding: "utf8" as const,
              sha256: hash(content),
            };
          },
          write: ({ path, content, expectedSha256 }) => {
            const current = files.get(path);
            const currentSha256 = current === undefined ? null : hash(current);
            if (currentSha256 !== expectedSha256) {
              return { outcome: "conflict" as const, currentSha256 };
            }
            files.set(path, content);
            return {
              outcome: "written" as const,
              sha256: hash(content),
              sizeBytes: content.length,
            };
          },
        },
      },
    });
    hosts.push(host);
    const context = createPluginContext(host.bb);
    const pulled = component("gateway-firmware", "firmware");
    seedAccepted(context, [pulled]);
    registerCanvasEditingBackend(host.bb, context);

    const loaded = canvasEditingLoadOutputSchema.parse(
      await host.harness.callRpc("canvasEditingLoad", {
        projectId: PROJECT,
        projectVersionId: null,
        kind: "component",
        slug: pulled.slug,
      }),
    );
    expect(loaded).toMatchObject({
      state: "ready",
      fields: { component_type: "firmware" },
    });
    if (loaded.state !== "ready") throw new Error("expected accepted entity");

    await host.harness.callRpc("taraCommandApply", {
      projectId: PROJECT,
      projectVersionId: null,
      operation: "update",
      kind: "component",
      stableKey: pulled.slug,
      fields: { name: "Edited firmware gateway" },
      expectedContentSha256: loaded.sha256,
    });

    const edited = canvasEditingLoadOutputSchema.parse(
      await host.harness.callRpc("canvasEditingLoad", {
        projectId: PROJECT,
        projectVersionId: null,
        kind: "component",
        slug: pulled.slug,
      }),
    );
    expect(edited).toMatchObject({
      state: "ready",
      fields: {
        name: "Edited firmware gateway",
        component_type: "firmware",
      },
    });
    const authored = files.get(
      "/workspace/product-security/architecture/components/gateway-firmware.yaml",
    );
    expect(authored).toContain("component_type: firmware");
    expect(
      parseArchitectureEntity(
        "component",
        edited.state === "ready" ? edited.fields : {},
      ),
    ).toMatchObject({ component_type: "firmware" });
  });
});
