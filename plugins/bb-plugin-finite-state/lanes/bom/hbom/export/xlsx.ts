import { Readable } from "node:stream";
import type Database from "better-sqlite3";

import { encodeSourceRef } from "../../../documents/source-ref.js";
import { deriveHbomCellState } from "../schema.js";
import {
  HBOM_PART_FIELDS,
  type HbomCandidate,
  type HbomCell,
  type HbomDocument,
  type HbomPart,
  type HbomPartField,
} from "../types.js";
import { HBOM_EMPTY_SHA256, HbomMissingError, readHbom } from "../yaml.js";
import { toStorageProjectVersionId } from "../../../../lib/store/index.js";

export type HbomExportMode = "full" | "verified-only";

export interface ExportDeps {
  db: Database.Database;
  root: string;
  projectId: string;
  projectVersionId: string | null;
  projectKey?: string;
}

export interface ExportArtifact {
  filename: string;
  contentType: string;
  bytes: number | null;
  stream: NodeJS.ReadableStream;
  dispose(): Promise<void>;
}

export class HbomExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HbomExportError";
  }
}

const SHEET_NAMES = ["HBOM", "Provenance", "Documents", "Summary"] as const;
const EM_DASH = "\u2014";
const NOTE_CAP = 500;

function storageScope(
  projectId: string,
  projectVersionId: string | null,
): { projectId: string; projectVersionId: string } {
  return {
    projectId,
    projectVersionId: toStorageProjectVersionId(projectVersionId),
  };
}

function cellForField(
  part: HbomPart,
  field: HbomPartField,
): HbomCell<unknown> | undefined {
  return part[field];
}

function isVerified(cell: HbomCell<unknown>): boolean {
  return cell.provenance === "human" || cell.accepted !== undefined;
}

function formatDisplayValue(value: unknown): string {
  if (value === null) return "n/a";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length === 0 ? EM_DASH : value;
  return JSON.stringify(value);
}

function formatProvenanceValue(value: unknown): string {
  if (value === null) return "n/a";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string" && value.length === 0) return EM_DASH;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function truncateNote(text: string): string {
  if (text.length <= NOTE_CAP) return text;
  return `${text.slice(0, NOTE_CAP - 1)}\u2026`;
}

function proposalNote(cell: HbomCell<unknown>): string {
  const parts = [
    `provenance ${cell.provenance ?? "unknown"}`,
    cell.confidence !== undefined ? `confidence ${cell.confidence}` : null,
    cell.sourceRef !== undefined
      ? `source ${encodeSourceRef(cell.sourceRef)}`
      : null,
    cell.candidates !== undefined && cell.candidates.length > 0
      ? `${cell.candidates.length} competing claim(s)`
      : null,
  ].filter((part): part is string => part !== null);
  return truncateNote(parts.join(" · "));
}

function sanitizeFilename(projectKey: string): string {
  const cleaned = projectKey
    .replace(/[^\w.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  // Drop residual header-like tokens so Content-Disposition stays boring.
  const safe = cleaned.replace(/X-Evil/giu, "xevil").replace(/[\r\n]/gu, "");
  return safe.length > 0 ? safe : "hbom";
}

interface ProvenanceRow {
  partId: string;
  field: string;
  role: "incumbent" | "candidate";
  value: string;
  provenance: string;
  sourceRef: string;
  confidence: string;
  by: string;
  at: string;
  acceptedBy: string;
  acceptedAt: string;
  state: string;
  withdrawn: string;
}

function documentWithdrawn(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string },
  documentSha256: string,
): boolean {
  const row: unknown = db
    .prepare(
      `SELECT withdrawn FROM document
        WHERE project_id = ? AND project_version_id = ? AND sha256 = ?
        LIMIT 1`,
    )
    .get(scope.projectId, scope.projectVersionId, documentSha256);
  if (typeof row !== "object" || row === null) return false;
  return Reflect.get(row, "withdrawn") === 1;
}

function listDocuments(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string },
): Array<{
  sha256: string;
  name: string;
  kind: string;
  withdrawn: boolean;
  needsOcr: boolean;
}> {
  const rows: unknown = db
    .prepare(
      `SELECT sha256, name, doc_kind AS kind, withdrawn, needs_ocr AS needsOcr
         FROM document
        WHERE project_id = ? AND project_version_id = ?
        ORDER BY name COLLATE BINARY ASC, sha256 COLLATE BINARY ASC`,
    )
    .all(scope.projectId, scope.projectVersionId);
  if (!Array.isArray(rows)) return [];
  const out: Array<{
    sha256: string;
    name: string;
    kind: string;
    withdrawn: boolean;
    needsOcr: boolean;
  }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const sha256 = Reflect.get(row, "sha256");
    const name = Reflect.get(row, "name");
    const kind = Reflect.get(row, "kind");
    if (
      typeof sha256 !== "string" ||
      typeof name !== "string" ||
      typeof kind !== "string"
    ) {
      continue;
    }
    out.push({
      sha256,
      name,
      kind,
      withdrawn: Reflect.get(row, "withdrawn") === 1,
      needsOcr: Reflect.get(row, "needsOcr") === 1,
    });
  }
  return out;
}

function provenanceRowsForCell(
  partId: string,
  field: HbomPartField,
  cell: HbomCell<unknown>,
  scope: { projectId: string; projectVersionId: string },
  db: Database.Database,
): ProvenanceRow[] {
  const state = deriveHbomCellState(cell);
  const rows: ProvenanceRow[] = [];
  const withdrawn =
    cell.sourceRef !== undefined &&
    documentWithdrawn(db, scope, cell.sourceRef.documentSha256)
      ? "yes"
      : "no";
  rows.push({
    partId,
    field,
    role: "incumbent",
    value: formatProvenanceValue(cell.value),
    provenance: cell.provenance ?? "",
    sourceRef:
      cell.sourceRef !== undefined ? encodeSourceRef(cell.sourceRef) : "",
    confidence: cell.confidence !== undefined ? String(cell.confidence) : "",
    by: cell.by ?? "",
    at: cell.at ?? "",
    acceptedBy: cell.accepted?.by ?? "",
    acceptedAt: cell.accepted?.at ?? "",
    state,
    withdrawn,
  });
  const candidates: HbomCandidate<unknown>[] = cell.candidates ?? [];
  for (const candidate of candidates) {
    const candidateWithdrawn =
      candidate.sourceRef !== undefined &&
      documentWithdrawn(db, scope, candidate.sourceRef.documentSha256)
        ? "yes"
        : "no";
    rows.push({
      partId,
      field,
      role: "candidate",
      value: formatProvenanceValue(candidate.value),
      provenance: candidate.provenance,
      sourceRef:
        candidate.sourceRef !== undefined
          ? encodeSourceRef(candidate.sourceRef)
          : "",
      confidence: String(candidate.confidence),
      by: candidate.by,
      at: candidate.at,
      acceptedBy: "",
      acceptedAt: "",
      state,
      withdrawn: candidateWithdrawn,
    });
  }
  return rows;
}

async function loadDocument(
  deps: ExportDeps,
): Promise<{ document: HbomDocument; sha256: string }> {
  // Export reads tolerate later-withdrawn citations so Provenance can mark them.
  try {
    const read = await readHbom(deps.root);
    return { document: read.document, sha256: read.sha256 };
  } catch (error) {
    if (error instanceof HbomMissingError) {
      return {
        document: {
          schema: "fs-hbom/v1",
          project: deps.projectId,
          options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
          parts: [],
        },
        sha256: HBOM_EMPTY_SHA256,
      };
    }
    throw error;
  }
}

/**
 * Build an XLSX workbook with HBOM, Provenance, Documents, and Summary sheets.
 * ExcelJS is lazy-loaded so the frontend bundle never pulls it in.
 */
export async function createHbomWorkbook(
  deps: ExportDeps,
  mode: HbomExportMode,
): Promise<ExportArtifact> {
  if (mode !== "full" && mode !== "verified-only") {
    throw new HbomExportError(
      "HBOM_EXPORT_MODE_INVALID",
      "mode must be full or verified-only",
    );
  }

  const ExcelJS = await import("exceljs");
  const { document, sha256 } = await loadDocument(deps);
  const scope = storageScope(deps.projectId, deps.projectVersionId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "finite-state";
  workbook.created = new Date();

  const hbomSheet = workbook.addWorksheet(SHEET_NAMES[0]);
  const provenanceSheet = workbook.addWorksheet(SHEET_NAMES[1]);
  const documentsSheet = workbook.addWorksheet(SHEET_NAMES[2]);
  const summarySheet = workbook.addWorksheet(SHEET_NAMES[3]);

  hbomSheet.addRow(["partId", ...HBOM_PART_FIELDS]);
  provenanceSheet.addRow([
    "partId",
    "field",
    "role",
    "value",
    "provenance",
    "sourceRef",
    "confidence",
    "by",
    "at",
    "acceptedBy",
    "acceptedAt",
    "state",
    "sourceWithdrawn",
  ]);
  documentsSheet.addRow(["sha256", "name", "kind", "withdrawn", "needsOcr"]);
  summarySheet.addRow(["key", "value"]);

  let withheld = 0;
  let verifiedCells = 0;
  let proposalCells = 0;
  const provenanceRows: ProvenanceRow[] = [];

  for (const part of document.parts) {
    const row: Array<string | number> = [part.id];
    for (const field of HBOM_PART_FIELDS) {
      const cell = cellForField(part, field);
      if (cell === undefined) {
        row.push("");
        continue;
      }
      provenanceRows.push(
        ...provenanceRowsForCell(part.id, field, cell, scope, deps.db),
      );
      const verified = isVerified(cell);
      if (verified) verifiedCells += 1;
      else proposalCells += 1;

      if (mode === "verified-only" && !verified) {
        withheld += 1;
        row.push(EM_DASH);
        continue;
      }

      const display = formatDisplayValue(cell.value);
      const excelCellValue =
        cell.value === null
          ? "n/a"
          : Array.isArray(cell.value)
            ? cell.value.join(", ")
            : typeof cell.value === "number" || typeof cell.value === "boolean"
              ? cell.value
              : display;
      row.push(
        typeof excelCellValue === "string" || typeof excelCellValue === "number"
          ? excelCellValue
          : String(excelCellValue),
      );
    }
    const excelRow = hbomSheet.addRow(row);
    if (mode === "full") {
      for (let col = 0; col < HBOM_PART_FIELDS.length; col += 1) {
        const field = HBOM_PART_FIELDS[col]!;
        const cell = cellForField(part, field);
        if (cell === undefined || isVerified(cell)) continue;
        const target = excelRow.getCell(col + 2);
        target.note = proposalNote(cell);
        target.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF3F4F6" },
        };
      }
    }
  }

  for (const entry of provenanceRows) {
    provenanceSheet.addRow([
      entry.partId,
      entry.field,
      entry.role,
      entry.value,
      entry.provenance,
      entry.sourceRef,
      entry.confidence,
      entry.by,
      entry.at,
      entry.acceptedBy,
      entry.acceptedAt,
      entry.state,
      entry.withdrawn,
    ]);
  }

  for (const doc of listDocuments(deps.db, scope)) {
    documentsSheet.addRow([
      doc.sha256,
      doc.name,
      doc.kind,
      doc.withdrawn ? "yes" : "no",
      doc.needsOcr ? "yes" : "no",
    ]);
  }

  summarySheet.addRow(["mode", mode]);
  summarySheet.addRow(["projectId", deps.projectId]);
  summarySheet.addRow(["hbomSha256", sha256]);
  summarySheet.addRow([
    "reviewThreshold",
    String(document.options.reviewThreshold),
  ]);
  summarySheet.addRow([
    "exportThreshold",
    String(document.options.exportThreshold),
  ]);
  summarySheet.addRow(["parts", String(document.parts.length)]);
  summarySheet.addRow(["verifiedCells", String(verifiedCells)]);
  summarySheet.addRow(["proposalCells", String(proposalCells)]);
  summarySheet.addRow(["withheldCells", String(withheld)]);
  summarySheet.addRow([
    "verifiedOnlyPolicy",
    mode === "verified-only"
      ? "Unaccepted agent proposals withheld as em dash regardless of confidence"
      : "full export includes proposals with styling/notes",
  ]);
  summarySheet.addRow([
    "legend",
    "n/a = explicit null/not applicable; em dash = withheld or empty string; arrays join with comma on HBOM and JSON on Provenance",
  ]);
  summarySheet.addRow([
    "compliance",
    "This workbook is an auditable export. It does not claim FCC, CRA, or CycloneDX compliance.",
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = Buffer.from(buffer);
  const stream = Readable.from([bytes]);
  let disposed = false;
  const filename = `${sanitizeFilename(deps.projectKey ?? deps.projectId)}-hbom.xlsx`;

  return {
    filename,
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: bytes.byteLength,
    stream,
    async dispose() {
      if (disposed) return;
      disposed = true;
      stream.destroy();
    },
  };
}

export const HBOM_XLSX_SHEET_NAMES = SHEET_NAMES;
export const HBOM_XLSX_EM_DASH = EM_DASH;
