import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { MIGRATIONS } from "../../../lib/store/schema.js";
import { rebuildHbomMirror } from "./mirror.js";
import { createHbomWatcher } from "./repository.js";
import { HBOM_SCHEMA_ID, type HbomDocument } from "./types.js";
import {
  HBOM_EMPTY_SHA256,
  parseHbomText,
  serializeHbom,
  writeHbomCas,
} from "./yaml.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs-hbom-mirror-")));
  roots.push(root);
  const host = createFakePluginHost({
    pluginId: `hbom-mirror-${hosts.length}-${Date.now()}`,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  return { root, db };
}

function simpleDocument(): HbomDocument {
  return {
    schema: HBOM_SCHEMA_ID,
    project: "acme-router",
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [
      {
        id: "HBOM-0001",
        asComponentId: null,
        supplier: {
          value: "Avnet",
          provenance: "human",
          confidence: 1,
          by: "reviewer",
          at: "2026-07-30T09:14:00.000Z",
        },
      },
    ],
  };
}

function fixture(): HbomDocument {
  const docA = "a".repeat(64);
  return {
    schema: HBOM_SCHEMA_ID,
    project: "acme-router",
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [
      {
        id: "HBOM-0001",
        asComponentId: "as-component-03",
        mpn: {
          value: "BCM6755KFEBG",
          provenance: "bom_import",
          sourceRef: {
            documentSha256: docA,
            locator: { kind: "sheet", sheet: "Sheet1", cell: "A14" },
          },
          confidence: 0.72,
          by: "bb-agent",
          at: "2026-07-29T14:02:11.000Z",
          candidates: [
            {
              value: "BCM6755KFEB",
              provenance: "datasheet",
              sourceRef: {
                documentSha256: docA,
                locator: { kind: "pdf", page: 7 },
              },
              confidence: 0.61,
              by: "bb-agent",
              at: "2026-07-29T14:02:11.000Z",
            },
          ],
        },
        supplier: {
          value: "Avnet",
          provenance: "human",
          confidence: 1,
          by: "reviewer",
          at: "2026-07-30T09:14:00.000Z",
        },
        countryOfOrigin: { value: null },
        description: {
          value: "Wi-Fi SoC",
          provenance: "as_component",
          confidence: 0.6,
          by: "seed",
          at: "2026-07-28T10:00:00.000Z",
          accepted: {
            by: "reviewer",
            at: "2026-07-30T09:11:00.000Z",
          },
        },
      },
    ],
  };
}

function cellRows(
  db: ReturnType<
    ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]
  >,
): Array<{ field: string; state: string; accepted_by: string | null }> {
  return db
    .prepare(
      `SELECT field, state, accepted_by FROM hbom_cells
        WHERE project_id = 'project-a'
        ORDER BY field`,
    )
    .all()
    .map((row) => {
      if (
        typeof row !== "object" ||
        row === null ||
        !("field" in row) ||
        !("state" in row) ||
        !("accepted_by" in row)
      ) {
        throw new Error("unexpected hbom_cells row shape");
      }
      const field = row.field;
      const state = row.state;
      const acceptedBy = row.accepted_by;
      if (typeof field !== "string" || typeof state !== "string") {
        throw new Error("unexpected hbom_cells column types");
      }
      if (acceptedBy !== null && typeof acceptedBy !== "string") {
        throw new Error("unexpected accepted_by type");
      }
      return { field, state, accepted_by: acceptedBy };
    });
}

describe("hbom mirror rebuild", () => {
  it("projects cells and candidates with derived states from a fixture", () => {
    const host = createFakePluginHost({
      pluginId: `hbom-mirror-static-${Date.now()}`,
    });
    hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS);

    const document = fixture();
    rebuildHbomMirror(db, document, {
      projectId: "project-a",
      projectVersionId: "version-a",
      fileSha256: "f".repeat(64),
      indexedAt: "2026-08-14T00:00:00.000Z",
    });

    const cells = cellRows(db);
    expect(cells.find((row) => row.field === "mpn")?.state).toBe("conflict");
    expect(cells.find((row) => row.field === "supplier")?.state).toBe(
      "verified",
    );
    expect(cells.find((row) => row.field === "countryOfOrigin")?.state).toBe(
      "unknown",
    );
    expect(cells.find((row) => row.field === "description")?.state).toBe(
      "verified",
    );
    expect(cells.find((row) => row.field === "description")?.accepted_by).toBe(
      "reviewer",
    );

    const candidateCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hbom_candidates WHERE project_id = 'project-a'`,
      )
      .get();
    if (
      typeof candidateCount !== "object" ||
      candidateCount === null ||
      !("c" in candidateCount) ||
      typeof candidateCount.c !== "number"
    ) {
      throw new Error("unexpected candidate count");
    }
    expect(candidateCount.c).toBe(1);

    rebuildHbomMirror(db, document, {
      projectId: "project-a",
      projectVersionId: "version-a",
      fileSha256: "f".repeat(64),
      indexedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(
      cellRows(db).map((row) => ({ field: row.field, state: row.state })),
    ).toEqual(cells.map((row) => ({ field: row.field, state: row.state })));
  });

  it("retains the prior mirror when external YAML is malformed", async () => {
    const { root, db } = await setup();
    const document = simpleDocument();
    const sha = await writeHbomCas(root, HBOM_EMPTY_SHA256, document);
    rebuildHbomMirror(db, parseHbomText(serializeHbom(document), "hbom.yaml"), {
      projectId: "project-a",
      projectVersionId: "version-a",
      fileSha256: sha,
    });

    const before = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hbom_cells WHERE project_id = 'project-a'`,
      )
      .get();
    if (
      typeof before !== "object" ||
      before === null ||
      !("c" in before) ||
      typeof before.c !== "number"
    ) {
      throw new Error("unexpected cell count");
    }
    expect(before.c).toBeGreaterThan(0);

    const published: Array<{ projectId: string }> = [];
    const validationErrors: unknown[] = [];
    const watcher = createHbomWatcher({
      db,
      root,
      projectId: "project-a",
      projectVersionId: "version-a",
      publish: (_channel, payload) => published.push(payload),
      onValidationError: (error) => validationErrors.push(error),
      debounceMs: 10,
    });

    await mkdir(join(root, "product-security", "hbom"), { recursive: true });
    await writeFile(
      join(root, "product-security", "hbom", "hbom.yaml"),
      "schema: fs-hbom/v1\nproject: acme\noptions: {}\nparts: []\n",
      "utf8",
    );
    watcher.notify();
    await watcher.flush();

    expect(validationErrors.length).toBeGreaterThan(0);
    const after = db
      .prepare(
        `SELECT COUNT(*) AS c FROM hbom_cells WHERE project_id = 'project-a'`,
      )
      .get();
    if (
      typeof after !== "object" ||
      after === null ||
      !("c" in after) ||
      typeof after.c !== "number"
    ) {
      throw new Error("unexpected cell count");
    }
    expect(after.c).toBe(before.c);
    expect(published).toEqual([]);
    watcher.close();
  });
});
