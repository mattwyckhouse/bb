import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { MIGRATIONS } from "../../../lib/store/schema.js";
import {
  createHbomWorkbook,
  HBOM_XLSX_EM_DASH,
  HBOM_XLSX_SHEET_NAMES,
  type ExportDeps,
} from "./export/xlsx.js";
import { HBOM_SCHEMA_ID, type HbomDocument } from "./types.js";
import { HBOM_EMPTY_SHA256, writeHbomCas } from "./yaml.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    [...roots.splice(0), ...temps.splice(0)].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

const DOC_A = "a".repeat(64);
const DOC_W = "e".repeat(64);

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs-hbom-xlsx-")));
  roots.push(root);
  const host = createFakePluginHost({
    pluginId: `hbom-xlsx-${hosts.length}-${Date.now()}`,
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
     ) VALUES
       (?, '@project', 'doc-a', ?, 'bom.xlsx', ?, 'bom', 'text/csv', 12, 0, 0,
        '2026-07-29T00:00:00.000Z', NULL, NULL, 0, '2026-07-29T00:00:00.000Z'),
       (?, '@project', 'doc-w', ?, 'old.pdf', ?, 'datasheet', 'application/pdf', 12, 0, 0,
        '2026-07-29T00:00:00.000Z', NULL, NULL, 0, '2026-07-29T00:00:00.000Z')`,
  ).run(
    "project-a",
    DOC_A,
    `product-security/documents/${DOC_A}-bom.xlsx`,
    "project-a",
    DOC_W,
    `product-security/documents/${DOC_W}-old.pdf`,
  );

  const document: HbomDocument = {
    schema: HBOM_SCHEMA_ID,
    project: "acme-router",
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [
      {
        id: "HBOM-0001",
        asComponentId: null,
        mpn: {
          value: "BCM6755",
          provenance: "datasheet",
          sourceRef: {
            documentSha256: DOC_A,
            locator: { kind: "pdf", page: 7 },
          },
          confidence: 0.95,
          by: "agent",
          at: "2026-08-01T00:00:00.000Z",
          candidates: [
            {
              value: "BCM6755-ALT",
              provenance: "bom_import",
              sourceRef: {
                documentSha256: DOC_W,
                locator: { kind: "sheet", sheet: "Sheet1", cell: "A1" },
              },
              confidence: 0.5,
              by: "agent",
              at: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
        referenceDesignators: {
          value: ["U1", "U1A"],
          provenance: "bom_import",
          sourceRef: {
            documentSha256: DOC_A,
            locator: { kind: "sheet", sheet: "Sheet1", cell: "B2" },
          },
          confidence: 0.8,
          by: "agent",
          at: "2026-08-01T00:00:00.000Z",
        },
        countryOfOrigin: { value: null },
        supplier: {
          value: "Avnet",
          provenance: "human",
          confidence: 1,
          by: "reviewer",
          at: "2026-08-02T00:00:00.000Z",
          accepted: {
            by: "reviewer",
            at: "2026-08-02T00:00:00.000Z",
          },
        },
        description: {
          value: "",
          provenance: "inferred",
          confidence: 0.2,
          by: "agent",
          at: "2026-08-01T00:00:00.000Z",
        },
      },
    ],
  };
  // Write while the document is still active in the ledger, then withdraw it so
  // export can mark sourceWithdrawn without failing YAML reads.
  await writeHbomCas(root, HBOM_EMPTY_SHA256, document);
  db.prepare(
    `UPDATE document SET withdrawn = 1
      WHERE project_id = ? AND project_version_id = '@project' AND sha256 = ?`,
  ).run("project-a", DOC_W);
  const deps: ExportDeps = {
    db,
    root,
    projectId: "project-a",
    projectVersionId: null,
    projectKey: "acme-router",
  };
  return { deps };
}

async function loadWorkbook(bytes: Uint8Array) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const dir = await mkdtemp(join(tmpdir(), "fs-hbom-xlsx-load-"));
  temps.push(dir);
  const file = join(dir, "book.xlsx");
  await writeFile(file, bytes);
  await workbook.xlsx.readFile(file);
  return workbook;
}

describe("createHbomWorkbook", () => {
  it("emits exactly four required sheets and a complete provenance ledger", async () => {
    const { deps } = await setup();
    const artifact = await createHbomWorkbook(deps, "full");
    const chunks: Buffer[] = [];
    for await (const chunk of artifact.stream) {
      chunks.push(Buffer.from(chunk));
    }
    await artifact.dispose();
    const workbook = await loadWorkbook(Uint8Array.from(Buffer.concat(chunks)));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      ...HBOM_XLSX_SHEET_NAMES,
    ]);
    const provenance = workbook.getWorksheet("Provenance");
    expect(provenance).toBeDefined();
    expect((provenance?.rowCount ?? 0) > 1).toBe(true);
    const summary = workbook.getWorksheet("Summary");
    const summaryText = JSON.stringify(summary?.getSheetValues() ?? []);
    expect(summaryText).toContain("withheldCells");
    expect(summaryText).toMatch(/does not claim/i);
    expect(summaryText).not.toMatch(/\bis compliant\b/i);
  });

  it("preserves arrays, n/a vs unknown, accepted audit, and withdrawn source", async () => {
    const { deps } = await setup();
    const artifact = await createHbomWorkbook(deps, "full");
    const chunks: Buffer[] = [];
    for await (const chunk of artifact.stream) {
      chunks.push(Buffer.from(chunk));
    }
    await artifact.dispose();
    const workbook = await loadWorkbook(Uint8Array.from(Buffer.concat(chunks)));
    const hbom = workbook.getWorksheet("HBOM");
    const row = hbom?.getRow(2).values;
    expect(JSON.stringify(row)).toContain("U1, U1A");
    expect(JSON.stringify(row)).toContain("n/a");
    const provenance = workbook.getWorksheet("Provenance");
    const values = JSON.stringify(provenance?.getSheetValues() ?? []);
    expect(values).toContain("reviewer");
    expect(values).toContain("yes");
    expect(values).toContain("candidate");
  });

  it("verified-only withholds unaccepted proposals as em dash and records count", async () => {
    const { deps } = await setup();
    const artifact = await createHbomWorkbook(deps, "verified-only");
    const chunks: Buffer[] = [];
    for await (const chunk of artifact.stream) {
      chunks.push(Buffer.from(chunk));
    }
    await artifact.dispose();
    const workbook = await loadWorkbook(Uint8Array.from(Buffer.concat(chunks)));
    const hbom = workbook.getWorksheet("HBOM");
    const rowText = JSON.stringify(hbom?.getRow(2).values ?? []);
    expect(rowText).toContain(HBOM_XLSX_EM_DASH);
    expect(rowText).toContain("Avnet");
    expect(rowText).not.toContain("BCM6755");
    const summary = JSON.stringify(
      workbook.getWorksheet("Summary")?.getSheetValues() ?? [],
    );
    expect(summary).toMatch(/withheldCells["\],:\s]+[1-9]/);
  });
});
