import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { encodeSourceRef } from "../../documents/source-ref.js";
import { deriveHbomCellState, type DocumentLedgerLookup } from "./schema.js";
import {
  HBOM_PART_FIELDS,
  type HbomCandidate,
  type HbomCell,
  type HbomDocument,
  type HbomPart,
  type HbomPartField,
} from "./types.js";

export interface HbomMirrorScope {
  projectId: string;
  projectVersionId: string;
  fileSha256: string;
  indexedAt?: string;
}

function cellForField(
  part: HbomPart,
  field: HbomPartField,
): HbomCell<unknown> | undefined {
  switch (field) {
    case "partNumber":
      return part.partNumber;
    case "mpn":
      return part.mpn;
    case "manufacturer":
      return part.manufacturer;
    case "description":
      return part.description;
    case "category":
      return part.category;
    case "quantity":
      return part.quantity;
    case "referenceDesignators":
      return part.referenceDesignators;
    case "lifecycleStatus":
      return part.lifecycleStatus;
    case "supplier":
      return part.supplier;
    case "countryOfOrigin":
      return part.countryOfOrigin;
    case "complianceFlags":
      return part.complianceFlags;
    case "fccCoveredList":
      return part.fccCoveredList;
    case "cryptoRelevant":
      return part.cryptoRelevant;
    case "securityRelevance":
      return part.securityRelevance;
    case "firmwareLink":
      return part.firmwareLink;
  }
}

function encodeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function encodeRef(
  ref: HbomCell<unknown>["sourceRef"] | HbomCandidate<unknown>["sourceRef"],
): string | null {
  if (ref === undefined) return null;
  return encodeSourceRef(ref);
}

function candidateId(
  partKey: string,
  field: string,
  index: number,
  candidate: HbomCandidate<unknown>,
): string {
  const material = JSON.stringify([
    partKey,
    field,
    index,
    candidate.value,
    candidate.provenance,
    candidate.sourceRef ?? null,
    candidate.confidence,
    candidate.by,
    candidate.at,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Rebuild disposable `hbom_cells` / `hbom_candidates` mirrors from YAML in one
 * transaction. Columns accelerate review queries; YAML remains authority.
 */
export function rebuildHbomMirror(
  db: Database.Database,
  document: HbomDocument,
  scope: HbomMirrorScope,
): void {
  const indexedAt = scope.indexedAt ?? new Date().toISOString();
  const clearCells = db.prepare(
    `DELETE FROM hbom_cells
      WHERE project_id = ? AND project_version_id = ?`,
  );
  const clearCandidates = db.prepare(
    `DELETE FROM hbom_candidates
      WHERE project_id = ? AND project_version_id = ?`,
  );
  const insertCell = db.prepare(
    `INSERT INTO hbom_cells (
       project_id, project_version_id, part_key, field, value, provenance,
       source_ref, confidence, asserted_by, asserted_at, note,
       accepted_by, accepted_at, state, file_sha256, indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCandidate = db.prepare(
    `INSERT INTO hbom_candidates (
       project_id, project_version_id, candidate_id, part_key, field, value,
       provenance, source_ref, confidence, asserted_by, asserted_at, status,
       indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    clearCells.run(scope.projectId, scope.projectVersionId);
    clearCandidates.run(scope.projectId, scope.projectVersionId);

    for (const part of document.parts) {
      for (const field of HBOM_PART_FIELDS) {
        const cell = cellForField(part, field);
        if (cell === undefined) continue;
        const state = deriveHbomCellState(cell);
        insertCell.run(
          scope.projectId,
          scope.projectVersionId,
          part.id,
          field,
          encodeValue(cell.value),
          cell.provenance ?? null,
          encodeRef(cell.sourceRef),
          cell.confidence ?? null,
          cell.by ?? null,
          cell.at ?? null,
          cell.note ?? null,
          cell.accepted?.by ?? null,
          cell.accepted?.at ?? null,
          state,
          scope.fileSha256,
          indexedAt,
        );

        if (cell.candidates === undefined) continue;
        const incumbent = JSON.stringify(cell.value);
        for (let index = 0; index < cell.candidates.length; index += 1) {
          const candidate = cell.candidates[index]!;
          let status: "pending" | "accepted" | "rejected" | "superseded" =
            "pending";
          if (
            cell.accepted !== undefined &&
            JSON.stringify(candidate.value) === incumbent
          ) {
            status = "accepted";
          }
          insertCandidate.run(
            scope.projectId,
            scope.projectVersionId,
            candidateId(part.id, field, index, candidate),
            part.id,
            field,
            encodeValue(candidate.value),
            candidate.provenance,
            encodeRef(candidate.sourceRef),
            candidate.confidence,
            candidate.by,
            candidate.at,
            status,
            indexedAt,
          );
        }
      }
    }
  });

  run();
}

export function createDocumentLedgerLookup(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string },
): DocumentLedgerLookup {
  const stmt = db.prepare(
    `SELECT 1 AS ok FROM document
      WHERE project_id = ? AND project_version_id = ? AND sha256 = ?
        AND withdrawn = 0
      LIMIT 1`,
  );
  return (documentSha256: string): boolean => {
    const row = stmt.get(
      scope.projectId,
      scope.projectVersionId,
      documentSha256,
    );
    return row !== undefined;
  };
}
