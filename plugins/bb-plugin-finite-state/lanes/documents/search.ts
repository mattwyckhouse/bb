import type Database from "better-sqlite3";
import type { DocumentSourceRef, JsonValue } from "../../shared/contract.js";
import type { DocumentExtractionRow } from "../../lib/store/index.js";
import { decodeSourceRef, encodeSourceRef } from "./source-ref.js";
import {
  assertExternalScope,
  emptyCache,
  getDocumentBySha,
  storageScope,
  type DocumentScope,
  DocumentStoreError,
} from "./store.js";

const SNIPPET_MAX = 240;

export interface DocumentSearchQuery {
  query: string;
  kinds?: string[];
  pageSize: number;
  continuation: string | null;
}

export interface DocumentSearchHit {
  projectId: string;
  projectVersionId: string | null;
  documentSha256: string;
  documentName: string;
  field: string;
  value: string;
  confidence: number | null;
  sourceRef: DocumentSourceRef;
  snippet?: string;
  target?: { surface: "hbom" | "requirements"; id: string; field?: string };
}

export interface Page<T> {
  items: T[];
  total: number | null;
  next: string | null;
  cache: ReturnType<typeof emptyCache>;
}

export interface DocumentExtractionInput {
  field: string;
  value: string | null;
  confidence: number | null;
  sourceRef: DocumentSourceRef;
  status?: "proposal" | "accepted" | "rejected" | "withdrawn";
  extractedBy?: string | null;
  target?: {
    surface: "hbom" | "requirements";
    id: string;
    field?: string;
  } | null;
  raw?: JsonValue | null;
}

export interface DocumentExtractionResult {
  written: number;
  skipped: number;
  diagnostics: string[];
}

interface CursorValue {
  uploadedAt: string;
  documentId: string;
}

interface ListCursor {
  uploadedAt: string;
  documentId: string;
}

function encodeCursor(prefix: string, value: object): string {
  return `${prefix}.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function decodeCursor<T extends object>(
  prefix: string,
  continuation: string | null,
  validate: (value: unknown) => value is T,
): T | null {
  if (continuation === null) return null;
  try {
    const [head, payload, extra] = continuation.split(".");
    if (head !== prefix || !payload || extra !== undefined) {
      throw new Error("bad");
    }
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (!validate(decoded)) throw new Error("bad");
    return decoded;
  } catch {
    throw new DocumentStoreError(
      "DOCUMENT_CONTINUATION_INVALID",
      "The documents continuation cursor is invalid; restart the query.",
    );
  }
}

function isListCursor(value: unknown): value is ListCursor {
  if (typeof value !== "object" || value === null) return false;
  const uploadedAt = Reflect.get(value, "uploadedAt");
  const documentId = Reflect.get(value, "documentId");
  return (
    typeof uploadedAt === "string" &&
    uploadedAt.length > 0 &&
    uploadedAt.length <= 64 &&
    typeof documentId === "string" &&
    documentId.length > 0 &&
    documentId.length <= 512
  );
}

function isSearchCursor(value: unknown): value is CursorValue {
  return isListCursor(value);
}

function boundedSnippet(
  value: string | null,
  query: string,
): string | undefined {
  if (value === null || value.length === 0) return undefined;
  const lower = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) {
    return value.slice(0, SNIPPET_MAX);
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(value.length, index + needle.length + 40);
  const slice = value.slice(start, end);
  return `${start > 0 ? "…" : ""}${slice}${end < value.length ? "…" : ""}`.slice(
    0,
    SNIPPET_MAX,
  );
}

function projectionFromRef(ref: DocumentSourceRef): {
  locator_kind: "pdf" | "sheet" | "text";
  page: number | null;
  bbox: string | null;
  sheet: string | null;
  cell: string | null;
  line_start: number | null;
  line_end: number | null;
} {
  if (ref.locator.kind === "pdf") {
    return {
      locator_kind: "pdf",
      page: ref.locator.page,
      bbox:
        ref.locator.bbox === undefined
          ? null
          : JSON.stringify(ref.locator.bbox),
      sheet: null,
      cell: null,
      line_start: null,
      line_end: null,
    };
  }
  if (ref.locator.kind === "sheet") {
    return {
      locator_kind: "sheet",
      page: null,
      bbox: null,
      sheet: ref.locator.sheet,
      cell: ref.locator.cell,
      line_start: null,
      line_end: null,
    };
  }
  return {
    locator_kind: "text",
    page: null,
    bbox: null,
    sheet: null,
    cell: null,
    line_start: ref.locator.lineStart,
    line_end: ref.locator.lineEnd,
  };
}

export function listDocuments(
  db: Database.Database,
  scope: DocumentScope,
  input: {
    pageSize: number;
    continuation: string | null;
    filters: Record<string, JsonValue>;
  },
): Page<{
  projectId: string;
  projectVersionId: string | null;
  kind: string;
  key: string;
  label: string;
  fields: Record<string, JsonValue>;
}> {
  assertExternalScope(scope);
  const stored = storageScope(scope);
  const cursor = decodeCursor("dl1", input.continuation, isListCursor);
  const kindFilter =
    typeof input.filters.kind === "string" ? input.filters.kind : null;
  const withdrawnFilter =
    typeof input.filters.withdrawn === "boolean"
      ? input.filters.withdrawn
      : null;

  const where: string[] = ["project_id = ?", "project_version_id = ?"];
  const params: Array<string | number> = [
    stored.projectId,
    stored.projectVersionId,
  ];
  if (kindFilter) {
    where.push("doc_kind = ?");
    params.push(kindFilter);
  }
  if (withdrawnFilter !== null) {
    where.push("withdrawn = ?");
    params.push(withdrawnFilter ? 1 : 0);
  }
  if (cursor) {
    where.push("(uploaded_at < ? OR (uploaded_at = ? AND document_id > ?))");
    params.push(cursor.uploadedAt, cursor.uploadedAt, cursor.documentId);
  }

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM document WHERE ${where
        .filter((clause) => !clause.includes("uploaded_at"))
        .join(" AND ")}`,
    )
    .get(
      stored.projectId,
      stored.projectVersionId,
      ...(kindFilter ? [kindFilter] : []),
      ...(withdrawnFilter !== null ? [withdrawnFilter ? 1 : 0] : []),
    ) as { count: number };

  const rows = db
    .prepare(
      `SELECT * FROM document
        WHERE ${where.join(" AND ")}
        ORDER BY uploaded_at DESC, document_id ASC
        LIMIT ?`,
    )
    .all(...params, input.pageSize + 1) as Array<{
    project_id: string;
    project_version_id: string;
    document_id: string;
    sha256: string;
    name: string;
    path: string;
    doc_kind: string;
    mime_type: string;
    bytes: number;
    withdrawn: 0 | 1;
    needs_ocr: 0 | 1;
    uploaded_at: string;
  }>;

  const pageRows = rows.slice(0, input.pageSize);
  const nextRow =
    rows.length > input.pageSize ? pageRows[pageRows.length - 1] : null;

  return {
    items: pageRows.map((row) => ({
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      kind: "document",
      key: row.document_id,
      label: row.name,
      fields: {
        sha256: row.sha256,
        path: row.path,
        docKind: row.doc_kind,
        mimeType: row.mime_type,
        bytes: row.bytes,
        withdrawn: row.withdrawn === 1,
        needsOcr: row.needs_ocr === 1,
        uploadedAt: row.uploaded_at,
        retention: "plugin-local",
      },
    })),
    total: totalRow.count,
    next: nextRow
      ? encodeCursor("dl1", {
          uploadedAt: nextRow.uploaded_at,
          documentId: nextRow.document_id,
        })
      : null,
    cache: emptyCache(pageRows.length === 0 ? "empty" : "fresh"),
  };
}

export function searchDocuments(
  db: Database.Database,
  scope: DocumentScope,
  query: DocumentSearchQuery,
): Page<DocumentSearchHit> {
  assertExternalScope(scope);
  const stored = storageScope(scope);
  const cursor = decodeCursor("ds1", query.continuation, isSearchCursor);
  const where: string[] = [
    "e.project_id = ?",
    "e.project_version_id = ?",
    "(e.field LIKE ? ESCAPE '\\' OR IFNULL(e.value, '') LIKE ? ESCAPE '\\')",
  ];
  const like = `%${query.query
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
  const params: Array<string | number> = [
    stored.projectId,
    stored.projectVersionId,
    like,
    like,
  ];
  if (query.kinds && query.kinds.length > 0) {
    where.push(`d.doc_kind IN (${query.kinds.map(() => "?").join(", ")})`);
    params.push(...query.kinds);
  }
  if (cursor) {
    where.push(
      "(e.extracted_at < ? OR (e.extracted_at = ? AND e.extraction_id > ?))",
    );
    params.push(cursor.uploadedAt, cursor.uploadedAt, cursor.documentId);
  }

  const rows = db
    .prepare(
      `SELECT e.extraction_id, e.field, e.value, e.confidence, e.source_ref,
              e.target_surface, e.target_id, e.target_field, e.extracted_at,
              d.sha256 AS document_sha256, d.name AS document_name
         FROM document_extraction e
         JOIN document d
           ON d.project_id = e.project_id
          AND d.project_version_id = e.project_version_id
          AND d.document_id = e.document_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.extracted_at DESC, e.extraction_id ASC
        LIMIT ?`,
    )
    .all(...params, query.pageSize + 1) as Array<{
    extraction_id: string;
    field: string;
    value: string | null;
    confidence: number | null;
    source_ref: string;
    target_surface: string | null;
    target_id: string | null;
    target_field: string | null;
    extracted_at: string;
    document_sha256: string;
    document_name: string;
  }>;

  const diagnostics: string[] = [];
  const items: DocumentSearchHit[] = [];
  for (const row of rows.slice(0, query.pageSize)) {
    try {
      const sourceRef = decodeSourceRef(row.source_ref);
      if (sourceRef.documentSha256 !== row.document_sha256) {
        diagnostics.push(
          `skipped ${row.extraction_id}: source_ref digest drifted from document`,
        );
        continue;
      }
      const hit: DocumentSearchHit = {
        projectId: scope.projectId,
        projectVersionId: scope.projectVersionId,
        documentSha256: row.document_sha256,
        documentName: row.document_name,
        field: row.field,
        value: row.value ?? "",
        confidence: row.confidence,
        sourceRef,
        snippet: boundedSnippet(row.value, query.query),
      };
      if (
        (row.target_surface === "hbom" ||
          row.target_surface === "requirements") &&
        typeof row.target_id === "string" &&
        row.target_id.length > 0
      ) {
        hit.target = {
          surface: row.target_surface,
          id: row.target_id,
          ...(row.target_field ? { field: row.target_field } : {}),
        };
      }
      items.push(hit);
    } catch (error) {
      diagnostics.push(
        `skipped ${row.extraction_id}: ${error instanceof Error ? error.message : "malformed"}`,
      );
    }
  }

  const nextSource =
    rows.length > query.pageSize ? rows[query.pageSize - 1] : null;
  void diagnostics;
  return {
    items,
    total: null,
    next: nextSource
      ? encodeCursor("ds1", {
          uploadedAt: nextSource.extracted_at,
          documentId: nextSource.extraction_id,
        })
      : null,
    cache: emptyCache(items.length === 0 ? "empty" : "fresh"),
  };
}

export function recordDocumentExtractions(
  db: Database.Database,
  scope: DocumentScope,
  documentSha256: string,
  items: DocumentExtractionInput[],
): DocumentExtractionResult {
  assertExternalScope(scope);
  const document = getDocumentBySha(db, scope, documentSha256);
  if (!document) {
    throw new DocumentStoreError(
      "DOCUMENT_NOT_FOUND",
      "Cannot record extractions for an unknown document SHA in scope.",
      404,
    );
  }
  const stored = storageScope(scope);
  let written = 0;
  let skipped = 0;
  const diagnostics: string[] = [];
  const insert = db.prepare(
    `INSERT INTO document_extraction (
       project_id, project_version_id, extraction_id, document_id, field, value,
       confidence, source_ref, locator_kind, page, bbox, sheet, cell,
       line_start, line_end, target_surface, target_id, target_field, status,
       extracted_by, extracted_at, raw
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const [index, item] of items.entries()) {
      try {
        if (item.sourceRef.documentSha256 !== documentSha256) {
          skipped += 1;
          diagnostics.push(
            `item ${index}: sourceRef.documentSha256 must match documentSha256`,
          );
          continue;
        }
        const encoded = encodeSourceRef(item.sourceRef);
        const projection = projectionFromRef(item.sourceRef);
        const extractionId = `${documentSha256.slice(0, 12)}-${index}-${Date.now().toString(36)}`;
        insert.run(
          stored.projectId,
          stored.projectVersionId,
          extractionId,
          document.documentId,
          item.field,
          item.value,
          item.confidence,
          encoded,
          projection.locator_kind,
          projection.page,
          projection.bbox,
          projection.sheet,
          projection.cell,
          projection.line_start,
          projection.line_end,
          item.target?.surface ?? null,
          item.target?.id ?? null,
          item.target?.field ?? null,
          item.status ?? "proposal",
          item.extractedBy ?? null,
          new Date().toISOString(),
          item.raw === undefined || item.raw === null
            ? null
            : JSON.stringify(item.raw),
        );
        written += 1;
      } catch (error) {
        skipped += 1;
        diagnostics.push(
          `item ${index}: ${error instanceof Error ? error.message : "rejected"}`,
        );
      }
    }
    db.prepare(
      `UPDATE document
          SET cells_extracted = (
            SELECT COUNT(*) FROM document_extraction
             WHERE project_id = ? AND project_version_id = ? AND document_id = ?
          ),
          analyzed_at = ?
        WHERE project_id = ? AND project_version_id = ? AND document_id = ?`,
    ).run(
      stored.projectId,
      stored.projectVersionId,
      document.documentId,
      new Date().toISOString(),
      stored.projectId,
      stored.projectVersionId,
      document.documentId,
    );
  });
  tx();
  return { written, skipped, diagnostics };
}

export function listDocumentExtractions(
  db: Database.Database,
  scope: DocumentScope,
  input: {
    documentId: string;
    pageSize: number;
    continuation: string | null;
  },
): Page<{
  projectId: string;
  projectVersionId: string | null;
  kind: string;
  key: string;
  label: string;
  fields: Record<string, JsonValue>;
}> {
  assertExternalScope(scope);
  const stored = storageScope(scope);
  const cursor = decodeCursor("de1", input.continuation, isListCursor);
  const where = ["project_id = ?", "project_version_id = ?", "document_id = ?"];
  const params: Array<string | number> = [
    stored.projectId,
    stored.projectVersionId,
    input.documentId,
  ];
  if (cursor) {
    where.push(
      "(extracted_at < ? OR (extracted_at = ? AND extraction_id > ?))",
    );
    params.push(cursor.uploadedAt, cursor.uploadedAt, cursor.documentId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM document_extraction
        WHERE ${where.join(" AND ")}
        ORDER BY extracted_at DESC, extraction_id ASC
        LIMIT ?`,
    )
    .all(...params, input.pageSize + 1) as DocumentExtractionRow[];

  const pageRows = rows.slice(0, input.pageSize);
  const nextRow =
    rows.length > input.pageSize ? pageRows[pageRows.length - 1] : null;
  return {
    items: pageRows.map((row) => ({
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      kind: "document_extraction",
      key: row.extraction_id,
      label: row.field,
      fields: {
        documentId: row.document_id,
        field: row.field,
        value: row.value,
        confidence: row.confidence,
        sourceRef: row.source_ref,
        locatorKind: row.locator_kind,
        page: row.page,
        bbox: row.bbox,
        sheet: row.sheet,
        cell: row.cell,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        targetSurface: row.target_surface,
        targetId: row.target_id,
        targetField: row.target_field,
        status: row.status,
        extractedBy: row.extracted_by,
        extractedAt: row.extracted_at,
      },
    })),
    total: null,
    next: nextRow
      ? encodeCursor("de1", {
          uploadedAt: nextRow.extracted_at,
          documentId: nextRow.extraction_id,
        })
      : null,
    cache: emptyCache(pageRows.length === 0 ? "empty" : "fresh"),
  };
}
