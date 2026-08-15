import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resolveNewestAcceptedProjectVersionId } from "./accepted-version.js";
import { openStore, PROJECT_LEVEL_VERSION_ID } from "./index.js";

const PROJECT_ID = "project-accepted-version";

function seedAccepted(
  db: ReturnType<typeof openStore>["db"],
  input: {
    versionId: string;
    generationId: string;
    entityKind: string;
    lastPull: string | null;
    accepted: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`,
  ).run(
    PROJECT_ID,
    input.versionId,
    input.generationId,
    input.accepted ? "accepted" : "failed",
    input.lastPull ?? "2026-08-01T00:00:00.000Z",
    input.lastPull ?? "2026-08-01T00:00:00.000Z",
    input.accepted ? (input.lastPull ?? "2026-08-01T00:00:00.000Z") : null,
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
    input.accepted ? input.generationId : null,
    input.lastPull,
  );
}

describe("resolveNewestAcceptedProjectVersionId", () => {
  it("returns a pinned version without consulting last_pull", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-accepted-version-pin",
    });
    const store = openStore(host.bb);
    seedAccepted(store.db, {
      versionId: "version-newer",
      generationId: "generation-newer",
      entityKind: "requirement",
      lastPull: "2026-08-15T12:00:00.000Z",
      accepted: true,
    });
    expect(
      resolveNewestAcceptedProjectVersionId(
        store.db,
        PROJECT_ID,
        "version-pinned",
        "requirement",
      ),
    ).toBe("version-pinned");
    await host.harness.lifecycle.dispose();
  });

  it("prefers the newest last_pull and breaks ties by project_version_id DESC", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-accepted-version-order",
    });
    const store = openStore(host.bb);
    seedAccepted(store.db, {
      versionId: PROJECT_LEVEL_VERSION_ID,
      generationId: "generation-project",
      entityKind: "requirement",
      lastPull: "2026-12-31T23:59:59.000Z",
      accepted: true,
    });
    seedAccepted(store.db, {
      versionId: "version-zzzz",
      generationId: "generation-old-zzzz",
      entityKind: "requirement",
      lastPull: "2026-08-01T00:00:00.000Z",
      accepted: true,
    });
    seedAccepted(store.db, {
      versionId: "version-aaaa",
      generationId: "generation-newer-aaaa",
      entityKind: "requirement",
      lastPull: "2026-08-15T12:00:00.000Z",
      accepted: true,
    });
    seedAccepted(store.db, {
      versionId: "version-mmmm",
      generationId: "generation-failed",
      entityKind: "requirement",
      lastPull: "2026-08-20T00:00:00.000Z",
      accepted: false,
    });
    seedAccepted(store.db, {
      versionId: "version-threat-only",
      generationId: "generation-threat",
      entityKind: "threat",
      lastPull: "2026-08-30T00:00:00.000Z",
      accepted: true,
    });

    expect(
      resolveNewestAcceptedProjectVersionId(
        store.db,
        PROJECT_ID,
        null,
        "requirement",
      ),
    ).toBe("version-aaaa");

    seedAccepted(store.db, {
      versionId: "version-zzzz-newer",
      generationId: "generation-zzzz-newer",
      entityKind: "requirement",
      lastPull: "2026-08-15T12:00:00.000Z",
      accepted: true,
    });
    expect(
      resolveNewestAcceptedProjectVersionId(
        store.db,
        PROJECT_ID,
        null,
        "requirement",
      ),
    ).toBe("version-zzzz-newer");
    expect(
      resolveNewestAcceptedProjectVersionId(
        store.db,
        PROJECT_ID,
        null,
        "threat",
      ),
    ).toBe("version-threat-only");
    expect(
      resolveNewestAcceptedProjectVersionId(
        store.db,
        PROJECT_ID,
        null,
        "verificationRun",
      ),
    ).toBeNull();
    await host.harness.lifecycle.dispose();
  });
});
