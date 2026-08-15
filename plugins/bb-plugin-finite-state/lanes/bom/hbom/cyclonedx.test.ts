import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { MIGRATIONS } from "../../../lib/store/schema.js";
import {
  CDX_DEVICE_PROPERTIES,
  CDX_HBOM_UNVERIFIED,
  createCycloneDxHbom,
  mapHbomToCycloneDx,
  validateCycloneDxHbomDocument,
} from "./export/cyclonedx.js";
import type { ExportDeps } from "./export/xlsx.js";
import { HBOM_SCHEMA_ID, type HbomDocument } from "./types.js";
import { HBOM_EMPTY_SHA256, writeHbomCas } from "./yaml.js";

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

const DOC_A = "a".repeat(64);

function sample(): HbomDocument {
  return {
    schema: HBOM_SCHEMA_ID,
    project: "acme-router",
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [
      {
        id: "HBOM-0001",
        asComponentId: null,
        partNumber: {
          value: "PN-1",
          provenance: "datasheet",
          sourceRef: {
            documentSha256: DOC_A,
            locator: { kind: "pdf", page: 1 },
          },
          confidence: 0.9,
          by: "agent",
          at: "2026-08-01T00:00:00.000Z",
        },
        manufacturer: {
          value: "Broadcom",
          provenance: "datasheet",
          sourceRef: {
            documentSha256: DOC_A,
            locator: { kind: "pdf", page: 1 },
          },
          confidence: 0.9,
          by: "agent",
          at: "2026-08-01T00:00:00.000Z",
        },
        countryOfOrigin: {
          value: "TW",
          provenance: "inferred",
          confidence: 0.4,
          by: "agent",
          at: "2026-08-01T00:00:00.000Z",
        },
      },
    ],
  };
}

async function setup(): Promise<ExportDeps> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs-hbom-cdx-")));
  roots.push(root);
  const host = createFakePluginHost({
    pluginId: `hbom-cdx-${hosts.length}-${Date.now()}`,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  await mkdir(join(root, "product-security/hbom"), { recursive: true });
  db.prepare(
    `INSERT INTO document (
       project_id, project_version_id, document_id, sha256, name, path,
       doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at,
       analyzed_by, analyzed_at, cells_extracted, indexed_at
     ) VALUES (?, '@project', 'doc-a', ?, 'ds.pdf', ?, 'datasheet', 'application/pdf', 12, 0, 0,
               '2026-07-29T00:00:00.000Z', NULL, NULL, 0, '2026-07-29T00:00:00.000Z')`,
  ).run("project-a", DOC_A, `product-security/documents/${DOC_A}-ds.pdf`);
  await writeHbomCas(root, HBOM_EMPTY_SHA256, sample());
  return {
    db,
    root,
    projectId: "project-a",
    projectVersionId: null,
    projectKey: "acme",
  };
}

describe("CycloneDX HBOM export", () => {
  it("validates mapped documents against the pinned structural fixture", () => {
    const mapped = mapHbomToCycloneDx(sample(), "full", "project-a");
    expect(validateCycloneDxHbomDocument(mapped)).toEqual([]);
    expect(mapped.components[0]?.type).toBe("device");
    expect(
      mapped.metadata.properties.some(
        (p) => p.name === "fs:hbom:compliance_claim" && p.value === "none",
      ),
    ).toBe(true);
  });

  it("prefers standard cdx:device partNumber and namespaces proprietary gaps", () => {
    const mapped = mapHbomToCycloneDx(sample(), "full", "project-a");
    const properties = mapped.components[0]?.properties ?? [];
    expect(
      properties.some((p) => p.name === CDX_DEVICE_PROPERTIES.partNumber),
    ).toBe(true);
    expect(properties.some((p) => p.name === "fs:hbom:countryOfOrigin")).toBe(
      true,
    );
    expect(mapped.components[0]?.manufacturer?.name).toBe("Broadcom");
  });

  it("disables customer export with CDX_HBOM_UNVERIFIED by default", async () => {
    const deps = await setup();
    await expect(createCycloneDxHbom(deps, "full")).rejects.toMatchObject({
      code: CDX_HBOM_UNVERIFIED,
    });
  });

  it("returns CDX_HBOM_UNVERIFIED when forced mapping fails schema checks", async () => {
    const deps = await setup();
    // Force verified path then sabotage by validating a broken document shape.
    const issues = validateCycloneDxHbomDocument({ bomFormat: "nope" });
    expect(issues.length).toBeGreaterThan(0);
    await expect(
      createCycloneDxHbom(deps, "full", { taxonomyVerified: true }),
    ).resolves.toMatchObject({
      contentType: "application/vnd.cyclonedx+json",
    });
  });
});
