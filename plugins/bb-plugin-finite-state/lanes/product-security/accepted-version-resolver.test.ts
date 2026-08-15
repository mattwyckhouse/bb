import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginContext } from "../../lib/context.js";
import { resolveNewestAcceptedProjectVersionId } from "../../lib/store/accepted-version.js";
import { PROJECT_LEVEL_VERSION_ID } from "../../lib/store/index.js";
import { reqIdKey } from "../../lib/sync/registry.js";
import { rpcContract } from "../../shared/contract.js";
import {
  registerThreatOverlayBackend,
  threatOverlayRpcContract,
} from "./canvas/threat-overlay/backend.js";
import { requirementSemanticSha256 } from "./requirements/cards/adapter.js";
import { registerRequirementsCardsBackend } from "./requirements/cards/backend.js";
import type { RequirementYamlV1 } from "./requirements/cards/schema.js";
import { registerRequirementsConversionBackend } from "./requirements/conversion/backend.js";
import { clearConversionBundlesForTests } from "./requirements/conversion/bundle.js";
import { clearConversionReportsForTests } from "./requirements/conversion/report.js";

const PROJECT_ID = "project-fs186";
const OLDER_PULL = "2026-08-01T00:00:00.000Z";
const NEWER_PULL = "2026-08-15T12:00:00.000Z";

function cachedRequirement(id: string): RequirementYamlV1 {
  return {
    schema: "fs-requirement/v1",
    id,
    req_type: "security",
    priority: "P1",
    status: "draft",
    ears: {
      pattern: "ubiquitous",
      text: "The gateway SHALL reject unsigned firmware",
      parts: { system: "gateway", response: "reject unsigned firmware" },
    },
    source_description: "Protect the update trust boundary.",
    mitigations: [],
    controls: [],
    standards: [],
    verification: [],
  };
}

function seedAcceptedKind(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
  input: {
    versionId: string;
    generationId: string;
    entityKind: string;
    lastPull: string;
    requirement?: RequirementYamlV1;
  },
): void {
  db.prepare(
    `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
     VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)`,
  ).run(
    PROJECT_ID,
    input.versionId,
    input.generationId,
    JSON.stringify([input.entityKind]),
    input.lastPull,
    input.lastPull,
    input.lastPull,
  );
  db.prepare(
    `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        base_revision, last_pull)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(
    PROJECT_ID,
    input.versionId,
    input.entityKind,
    input.generationId,
    input.lastPull,
  );
  if (!input.requirement) return;
  db.prepare(
    `INSERT INTO base_snapshot
       (project_id, project_version_id, entity_kind, generation_id, entity_key,
        remote_id, payload, content_hash, pulled_at)
     VALUES (?, ?, 'requirement', ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_ID,
    input.versionId,
    input.generationId,
    reqIdKey({ reqId: input.requirement.id }),
    `remote-${input.requirement.id}`,
    JSON.stringify(input.requirement),
    requirementSemanticSha256(input.requirement),
    input.lastPull,
  );
}

afterEach(() => {
  clearConversionBundlesForTests();
  clearConversionReportsForTests();
});

describe("newest-accepted-version resolver surfaces", () => {
  it("resolves the same newest accepted version across cards, traceability, conversion, and threat overlay", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-fs186-surfaces",
      sdk: {
        projects: {
          get: () => ({
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
        files: {
          list: () => ({ files: [], truncated: false }),
        },
      },
    });
    const ctx = createPluginContext(host.bb);
    const db = ctx.db();
    const winnerRequirement = cachedRequirement("REQ-winner");

    seedAcceptedKind(db, {
      versionId: PROJECT_LEVEL_VERSION_ID,
      generationId: "generation-project",
      entityKind: "requirement",
      lastPull: "2026-12-31T00:00:00.000Z",
    });
    seedAcceptedKind(db, {
      versionId: PROJECT_LEVEL_VERSION_ID,
      generationId: "generation-project-threat",
      entityKind: "threat",
      lastPull: "2026-12-31T00:00:00.000Z",
    });
    seedAcceptedKind(db, {
      versionId: "version-zzzz",
      generationId: "generation-old-req",
      entityKind: "requirement",
      lastPull: OLDER_PULL,
      requirement: cachedRequirement("REQ-old"),
    });
    seedAcceptedKind(db, {
      versionId: "version-zzzz",
      generationId: "generation-old-threat",
      entityKind: "threat",
      lastPull: OLDER_PULL,
    });
    seedAcceptedKind(db, {
      versionId: "version-aaaa",
      generationId: "generation-new-req",
      entityKind: "requirement",
      lastPull: NEWER_PULL,
      requirement: winnerRequirement,
    });
    seedAcceptedKind(db, {
      versionId: "version-aaaa",
      generationId: "generation-new-threat",
      entityKind: "threat",
      lastPull: NEWER_PULL,
    });

    registerRequirementsCardsBackend(host.bb, ctx);
    registerRequirementsConversionBackend(host.bb, ctx);
    registerThreatOverlayBackend(host.bb, ctx);

    const expectedRequirement = resolveNewestAcceptedProjectVersionId(
      db,
      PROJECT_ID,
      null,
      "requirement",
    );
    const expectedThreat = resolveNewestAcceptedProjectVersionId(
      db,
      PROJECT_ID,
      null,
      "threat",
    );
    expect(expectedRequirement).toBe("version-aaaa");
    expect(expectedThreat).toBe("version-aaaa");

    const cards = rpcContract.requirementsList.output.parse(
      await host.harness.callRpc("requirementsList", {
        projectId: PROJECT_ID,
        projectVersionId: null,
        pageSize: 50,
        continuation: null,
        filters: {},
      }),
    );
    const traceability = rpcContract.requirementsList.output.parse(
      await host.harness.callRpc("requirementsList", {
        projectId: PROJECT_ID,
        projectVersionId: null,
        pageSize: 50,
        continuation: null,
        filters: { view: "traceability" },
      }),
    );
    const conversion = rpcContract.earsConversionStart.output.parse(
      await host.harness.callRpc("earsConversionStart", {
        projectId: PROJECT_ID,
        projectVersionId: null,
        requirementIds: [],
      }),
    );
    const overlay = threatOverlayRpcContract.threatOverlaySnapshot.output.parse(
      await host.harness.callRpc("threatOverlaySnapshot", {
        projectId: PROJECT_ID,
        projectVersionId: null,
      }),
    );

    const surfaced = [
      cards.items[0]?.projectVersionId,
      traceability.items[0]?.projectVersionId,
      conversion.projectVersionId,
      overlay.projectVersionId,
    ];
    expect(new Set(surfaced)).toEqual(new Set(["version-aaaa"]));
    expect(cards.items.map((item) => item.key)).toEqual(["REQ-winner"]);
    expect(traceability.items.map((item) => item.key)).toEqual(["REQ-winner"]);

    seedAcceptedKind(db, {
      versionId: "version-zzzz-newer",
      generationId: "generation-tie-req",
      entityKind: "requirement",
      lastPull: NEWER_PULL,
      requirement: cachedRequirement("REQ-tie"),
    });
    seedAcceptedKind(db, {
      versionId: "version-zzzz-newer",
      generationId: "generation-tie-threat",
      entityKind: "threat",
      lastPull: NEWER_PULL,
    });

    const tiedRequirement = resolveNewestAcceptedProjectVersionId(
      db,
      PROJECT_ID,
      null,
      "requirement",
    );
    const cardsTied = rpcContract.requirementsList.output.parse(
      await host.harness.callRpc("requirementsList", {
        projectId: PROJECT_ID,
        projectVersionId: null,
        pageSize: 50,
        continuation: null,
        filters: {},
      }),
    );
    const traceabilityTied = rpcContract.requirementsList.output.parse(
      await host.harness.callRpc("requirementsList", {
        projectId: PROJECT_ID,
        projectVersionId: null,
        pageSize: 50,
        continuation: null,
        filters: { view: "traceability" },
      }),
    );
    const conversionTied = rpcContract.earsConversionStart.output.parse(
      await host.harness.callRpc("earsConversionStart", {
        projectId: PROJECT_ID,
        projectVersionId: null,
        requirementIds: [],
      }),
    );
    const overlayTied =
      threatOverlayRpcContract.threatOverlaySnapshot.output.parse(
        await host.harness.callRpc("threatOverlaySnapshot", {
          projectId: PROJECT_ID,
          projectVersionId: null,
        }),
      );
    expect(tiedRequirement).toBe("version-zzzz-newer");
    expect([
      cardsTied.items[0]?.projectVersionId,
      traceabilityTied.items[0]?.projectVersionId,
      conversionTied.projectVersionId,
      overlayTied.projectVersionId,
    ]).toEqual([
      "version-zzzz-newer",
      "version-zzzz-newer",
      "version-zzzz-newer",
      "version-zzzz-newer",
    ]);
    await host.harness.lifecycle.dispose();
  });
});
