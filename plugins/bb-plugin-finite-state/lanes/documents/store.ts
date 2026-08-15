import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type Database from "better-sqlite3";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { JsonValue } from "../../shared/contract.js";
import {
  fromStorageProjectVersionId,
  toStorageProjectVersionId,
  type DocumentRow,
} from "../../lib/store/index.js";

export const DOCUMENTS_DIRECTORY = "product-security/documents";
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const DOCUMENTS_CHANGED_CHANNEL = "documents:changed" as const;

export type DocumentKind =
  | "datasheet"
  | "bom"
  | "schematic"
  | "spec"
  | "regulatory"
  | "register_map"
  | "other";

export interface DocumentScope {
  projectId: string;
  projectVersionId: string | null;
}

export interface DocumentRecord {
  projectId: string;
  projectVersionId: string | null;
  sha256: string;
  name: string;
  path: string;
  kind: DocumentKind;
  mimeType: string;
  bytes: number;
  uploadedAt: string;
  documentId: string;
  withdrawn: boolean;
  needsOcr: boolean;
}

export class DocumentStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "DocumentStoreError";
  }
}

const DOC_KINDS = new Set<DocumentKind>([
  "datasheet",
  "bom",
  "schematic",
  "spec",
  "regulatory",
  "register_map",
  "other",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".csv",
  ".xlsx",
  ".svd",
  ".xml",
  ".txt",
  ".h",
  ".hpp",
  ".c",
  ".inc",
]);

function isDocumentKind(value: string): value is DocumentKind {
  for (const kind of DOC_KINDS) {
    if (kind === value) return true;
  }
  return false;
}

export function assertExternalScope(scope: DocumentScope): void {
  if (scope.projectId.trim().length < 1 || scope.projectId.length > 512) {
    throw new DocumentStoreError(
      "DOCUMENT_SCOPE_INVALID",
      "projectId is required.",
    );
  }
  if (scope.projectId === "@project" || scope.projectVersionId === "@project") {
    throw new DocumentStoreError(
      "DOCUMENT_SENTINEL_REJECTED",
      'External "@project" is rejected; use null for project-level scope.',
    );
  }
  if (scope.projectVersionId !== null && scope.projectVersionId.length < 1) {
    throw new DocumentStoreError(
      "DOCUMENT_SCOPE_INVALID",
      "projectVersionId must be non-empty or null.",
    );
  }
}

export function storageScope(scope: DocumentScope): {
  projectId: string;
  projectVersionId: string;
} {
  assertExternalScope(scope);
  return {
    projectId: scope.projectId,
    projectVersionId: toStorageProjectVersionId(scope.projectVersionId),
  };
}

export function sanitizeDocumentFilename(filename: string): string {
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename.includes("..")
  ) {
    throw new DocumentStoreError(
      "DOCUMENT_FILENAME_INVALID",
      "Filename must be a sanitized basename without path separators.",
    );
  }
  const base = basename(filename).trim();
  if (
    base.length < 1 ||
    base.length > 200 ||
    base === "." ||
    base === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/u.test(base)
  ) {
    throw new DocumentStoreError(
      "DOCUMENT_FILENAME_INVALID",
      "Filename must be a sanitized basename without path separators.",
    );
  }
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot >= 0 ? lower.slice(dot) : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new DocumentStoreError(
      "DOCUMENT_TYPE_UNSUPPORTED",
      "Filename extension is not in the allowed document set.",
    );
  }
  return base;
}

/** Display labels are not filenames — match the frozen contract bounds only. */
export function sanitizeDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 1000) {
    throw new DocumentStoreError(
      "DOCUMENT_DISPLAY_NAME_INVALID",
      "displayName must be a non-empty string of at most 1000 characters.",
    );
  }
  return trimmed;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT" ||
    /UNIQUE constraint failed/iu.test(error.message)
  );
}

function blobExistsAt(worktreeRoot: string, relativePath: string): boolean {
  try {
    const absolute = confinedAbsolute(worktreeRoot, relativePath);
    return existsSync(absolute) && statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function materializeBlobFromBytes(
  worktreeRoot: string,
  relativePath: string,
  bytes: Buffer,
  expectedSha256: string,
): void {
  const destination = confinedAbsolute(worktreeRoot, relativePath);
  const documentsDir = confinedAbsolute(worktreeRoot, DOCUMENTS_DIRECTORY);
  mkdirSync(documentsDir, { recursive: true });
  const stagingRoot = mkdtempSync(join(tmpdir(), "fs-docs-heal-"));
  const stagingFile = join(stagingRoot, `${expectedSha256}.bin`);
  try {
    writeFileSync(stagingFile, bytes);
    const stagedHash = createHash("sha256")
      .update(readFileSync(stagingFile))
      .digest("hex");
    if (stagedHash !== expectedSha256) {
      throw new DocumentStoreError(
        "DOCUMENT_SHA256_MISMATCH",
        "Healed blob digest drifted before promote.",
      );
    }
    try {
      renameSync(stagingFile, destination);
    } catch {
      if (!blobExistsAt(worktreeRoot, relativePath)) {
        throw new DocumentStoreError(
          "DOCUMENT_PROMOTE_FAILED",
          "Atomic heal promote into product-security/documents failed.",
          500,
        );
      }
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function sniffMime(
  bytes: Uint8Array,
  filename: string,
  declared: string | undefined,
): string {
  const extension = extensionOf(filename);
  let detected: string | null = null;
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    detected = "application/pdf";
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04 &&
    extension === ".xlsx"
  ) {
    detected =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (extension === ".csv") {
    detected = "text/csv";
  } else if (extension === ".svd" || extension === ".xml") {
    detected = "application/xml";
  } else if (
    extension === ".txt" ||
    extension === ".h" ||
    extension === ".hpp" ||
    extension === ".c" ||
    extension === ".inc"
  ) {
    detected = "text/plain";
  }

  if (detected === null) {
    throw new DocumentStoreError(
      "DOCUMENT_TYPE_UNSUPPORTED",
      "Document bytes/extension are not recognized.",
    );
  }
  if (declared !== undefined && declared.length > 0 && declared !== detected) {
    throw new DocumentStoreError(
      "DOCUMENT_MIME_MISMATCH",
      "Declared MIME type does not match detected document type.",
    );
  }
  return detected;
}

function inferKind(
  filename: string,
  mimeType: string,
  declared: string | undefined,
): DocumentKind {
  if (declared !== undefined) {
    if (!isDocumentKind(declared)) {
      throw new DocumentStoreError(
        "DOCUMENT_TYPE_UNSUPPORTED",
        "doc_kind is outside the frozen vocabulary.",
      );
    }
    return declared;
  }
  const extension = extensionOf(filename);
  if (extension === ".svd" || extension === ".h" || extension === ".hpp") {
    return "register_map";
  }
  if (extension === ".csv" || extension === ".xlsx") return "bom";
  if (mimeType === "application/pdf") return "datasheet";
  return "other";
}

function confinedAbsolute(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const child = relative(resolve(root), absolute);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    resolve(child) === child
  ) {
    throw new DocumentStoreError(
      "DOCUMENT_TRAVERSAL",
      "Document path escaped the worktree documents directory.",
    );
  }
  return absolute;
}

export function documentRelativePath(sha256: string, name: string): string {
  return `${DOCUMENTS_DIRECTORY}/${sha256}-${name}`;
}

export function rowToRecord(row: DocumentRow): DocumentRecord {
  return {
    projectId: row.project_id,
    projectVersionId: fromStorageProjectVersionId(row.project_version_id),
    sha256: row.sha256,
    name: row.name,
    path: row.path,
    kind: row.doc_kind,
    mimeType: row.mime_type,
    bytes: row.bytes,
    uploadedAt: row.uploaded_at,
    documentId: row.document_id,
    withdrawn: row.withdrawn === 1,
    needsOcr: row.needs_ocr === 1,
  };
}

export function getDocumentBySha(
  db: Database.Database,
  scope: DocumentScope,
  sha256: string,
): DocumentRecord | null {
  const stored = storageScope(scope);
  const row = db
    .prepare(
      `SELECT * FROM document
        WHERE project_id = ? AND project_version_id = ? AND sha256 = ?
        LIMIT 1`,
    )
    .get(stored.projectId, stored.projectVersionId, sha256) as
    | DocumentRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

export function getDocumentById(
  db: Database.Database,
  scope: DocumentScope,
  documentId: string,
): DocumentRecord | null {
  const stored = storageScope(scope);
  const row = db
    .prepare(
      `SELECT * FROM document
        WHERE project_id = ? AND project_version_id = ? AND document_id = ?
        LIMIT 1`,
    )
    .get(stored.projectId, stored.projectVersionId, documentId) as
    | DocumentRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

export async function resolveProjectWorktreeRoot(
  bb: BbPluginApi,
  projectId: string,
): Promise<string> {
  const project = await bb.sdk.projects.get({ projectId });
  const source =
    project.sources.find((candidate) => candidate.isDefault) ??
    project.sources[0];
  if (!source || typeof source.path !== "string" || source.path.length < 1) {
    throw new DocumentStoreError(
      "DOCUMENT_WORKTREE_REQUIRED",
      "Documents require a configured project workspace path.",
      409,
    );
  }
  if (!existsSync(source.path) || !statSync(source.path).isDirectory()) {
    throw new DocumentStoreError(
      "DOCUMENT_WORKTREE_REQUIRED",
      "Configured project workspace path is missing.",
      409,
    );
  }
  return realpathSync(source.path);
}

export interface UploadResult {
  record: DocumentRecord;
  created: boolean;
}

function insertDocumentRow(
  db: Database.Database,
  scope: DocumentScope,
  record: Omit<DocumentRecord, "projectId" | "projectVersionId">,
): DocumentRecord {
  const stored = storageScope(scope);
  const now = record.uploadedAt;
  db.prepare(
    `INSERT INTO document (
       project_id, project_version_id, document_id, sha256, name, path,
       doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at,
       analyzed_by, analyzed_at, cells_extracted, indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, 0, ?)`,
  ).run(
    stored.projectId,
    stored.projectVersionId,
    record.documentId,
    record.sha256,
    record.name,
    record.path,
    record.kind,
    record.mimeType,
    record.bytes,
    now,
    now,
  );
  return {
    ...record,
    projectId: scope.projectId,
    projectVersionId: scope.projectVersionId,
  };
}

export async function uploadDocumentEnvelope(
  db: Database.Database,
  bb: BbPluginApi,
  raw: unknown,
  publish: (payload: {
    projectId: string;
    projectVersionId: string | null;
    documentSha256: string;
  }) => void,
): Promise<UploadResult> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DocumentStoreError(
      "DOCUMENT_ENVELOPE_INVALID",
      "Upload body must be a JSON object.",
    );
  }
  const envelopeVersion = Reflect.get(raw, "envelopeVersion");
  if (envelopeVersion !== 1) {
    throw new DocumentStoreError(
      "DOCUMENT_ENVELOPE_VERSION_UNSUPPORTED",
      "Unknown envelopeVersion; version 1 is required (version 2 reserved for native multipart).",
    );
  }

  const projectId = Reflect.get(raw, "projectId");
  const projectVersionId = Reflect.get(raw, "projectVersionId");
  const filenameRaw = Reflect.get(raw, "filename");
  const declaredSha = Reflect.get(raw, "sha256");
  const metadataRaw = Reflect.get(raw, "metadata");
  const contentBase64 = Reflect.get(raw, "contentBase64");

  if (typeof projectId !== "string") {
    throw new DocumentStoreError(
      "DOCUMENT_SCOPE_INVALID",
      "projectId must be a string.",
    );
  }
  if (!(projectVersionId === null || typeof projectVersionId === "string")) {
    throw new DocumentStoreError(
      "DOCUMENT_SCOPE_INVALID",
      "projectVersionId must be a string or null.",
    );
  }
  if (typeof filenameRaw !== "string" || typeof declaredSha !== "string") {
    throw new DocumentStoreError(
      "DOCUMENT_ENVELOPE_INVALID",
      "filename and sha256 are required strings.",
    );
  }
  if (typeof contentBase64 !== "string" || contentBase64.length < 1) {
    throw new DocumentStoreError(
      "DOCUMENT_BASE64_INVALID",
      "contentBase64 is required.",
    );
  }
  if (
    contentBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(contentBase64)
  ) {
    throw new DocumentStoreError(
      "DOCUMENT_BASE64_INVALID",
      "contentBase64 is not valid base64.",
    );
  }
  if (
    metadataRaw !== undefined &&
    (typeof metadataRaw !== "object" ||
      metadataRaw === null ||
      Array.isArray(metadataRaw))
  ) {
    throw new DocumentStoreError(
      "DOCUMENT_ENVELOPE_INVALID",
      "metadata must be an object when provided.",
    );
  }

  const scope: DocumentScope = { projectId, projectVersionId };
  assertExternalScope(scope);
  if (!/^[a-f0-9]{64}$/u.test(declaredSha)) {
    throw new DocumentStoreError(
      "DOCUMENT_SHA256_INVALID",
      "Declared sha256 must be a lowercase 64-hex digest.",
    );
  }

  const filename = sanitizeDocumentFilename(filenameRaw);
  const kindHint =
    metadataRaw && typeof Reflect.get(metadataRaw, "kind") === "string"
      ? String(Reflect.get(metadataRaw, "kind"))
      : undefined;
  const mimeHint =
    metadataRaw && typeof Reflect.get(metadataRaw, "mimeType") === "string"
      ? String(Reflect.get(metadataRaw, "mimeType"))
      : undefined;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(contentBase64, "base64");
  } catch {
    throw new DocumentStoreError(
      "DOCUMENT_BASE64_INVALID",
      "contentBase64 could not be decoded.",
    );
  }
  if (decoded.byteLength < 1) {
    throw new DocumentStoreError(
      "DOCUMENT_BASE64_INVALID",
      "Decoded content is empty.",
    );
  }
  if (decoded.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentStoreError(
      "DOCUMENT_OVERSIZED",
      "Decoded document exceeds the 50 MiB cap.",
      413,
    );
  }

  const computed = createHash("sha256").update(decoded).digest("hex");
  if (computed !== declaredSha) {
    throw new DocumentStoreError(
      "DOCUMENT_SHA256_MISMATCH",
      "Declared sha256 does not match computed digest of decoded bytes.",
    );
  }

  const worktreeRoot = await resolveProjectWorktreeRoot(bb, scope.projectId);
  const existing = getDocumentBySha(db, scope, computed);
  if (existing) {
    if (!blobExistsAt(worktreeRoot, existing.path)) {
      materializeBlobFromBytes(worktreeRoot, existing.path, decoded, computed);
    }
    return { record: existing, created: false };
  }

  const mimeType = sniffMime(decoded, filename, mimeHint);
  const kind = inferKind(filename, mimeType, kindHint);
  const relativePath = documentRelativePath(computed, filename);
  const destination = confinedAbsolute(worktreeRoot, relativePath);
  const documentsDir = confinedAbsolute(worktreeRoot, DOCUMENTS_DIRECTORY);
  mkdirSync(documentsDir, { recursive: true });

  const stagingRoot = await mkdtemp(join(tmpdir(), "fs-docs-"));
  const stagingFile = join(stagingRoot, `${computed}.bin`);
  try {
    await pipeline(Readable.from(decoded), createWriteStream(stagingFile));
    const stagedHash = createHash("sha256")
      .update(readFileSync(stagingFile))
      .digest("hex");
    if (stagedHash !== computed) {
      throw new DocumentStoreError(
        "DOCUMENT_SHA256_MISMATCH",
        "Staged file digest drifted before promote.",
      );
    }
    try {
      renameSync(stagingFile, destination);
    } catch {
      // Another concurrent upload may have already promoted identical bytes.
      if (!blobExistsAt(worktreeRoot, relativePath)) {
        throw new DocumentStoreError(
          "DOCUMENT_PROMOTE_FAILED",
          "Atomic promote into product-security/documents failed.",
          500,
        );
      }
    }

    const uploadedAt = new Date().toISOString();
    let record: DocumentRecord;
    try {
      record = insertDocumentRow(db, scope, {
        sha256: computed,
        name: filename,
        path: relativePath,
        kind,
        mimeType,
        bytes: decoded.byteLength,
        uploadedAt,
        documentId: computed,
        withdrawn: false,
        needsOcr: false,
      });
    } catch (error) {
      // Never unlink the promoted content path: a concurrent winner may own it.
      // Staging cleanup happens in finally. Idempotent losers return the winner.
      const winner = getDocumentBySha(db, scope, computed);
      if (winner) {
        return { record: winner, created: false };
      }
      if (isUniqueConstraintError(error)) {
        const raced = getDocumentBySha(db, scope, computed);
        if (raced) return { record: raced, created: false };
      }
      throw error;
    }

    publish({
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      documentSha256: computed,
    });
    return { record, created: true };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function updateDocumentMetadata(
  db: Database.Database,
  scope: DocumentScope,
  input: {
    documentId: string;
    expectedContentSha256: string;
    kind: DocumentKind;
    withdrawn: boolean;
    displayName: string;
  },
): DocumentRecord {
  assertExternalScope(scope);
  const current = getDocumentById(db, scope, input.documentId);
  if (!current) {
    throw new DocumentStoreError(
      "DOCUMENT_NOT_FOUND",
      "Document is unknown in this project/version scope.",
      404,
    );
  }
  if (current.sha256 !== input.expectedContentSha256) {
    throw new DocumentStoreError(
      "DOCUMENT_SHA256_MISMATCH",
      "expectedContentSha256 does not match the ledger digest.",
      409,
    );
  }
  const name = sanitizeDisplayName(input.displayName);
  const stored = storageScope(scope);
  db.prepare(
    `UPDATE document
        SET doc_kind = ?, withdrawn = ?, name = ?, indexed_at = ?
      WHERE project_id = ? AND project_version_id = ? AND document_id = ?`,
  ).run(
    input.kind,
    input.withdrawn ? 1 : 0,
    name,
    new Date().toISOString(),
    stored.projectId,
    stored.projectVersionId,
    input.documentId,
  );
  const updated = getDocumentById(db, scope, input.documentId);
  if (!updated) {
    throw new DocumentStoreError(
      "DOCUMENT_NOT_FOUND",
      "Document disappeared after metadata update.",
      500,
    );
  }
  return updated;
}

export function readDocumentBytes(
  worktreeRoot: string,
  record: DocumentRecord,
): Buffer {
  const absolute = confinedAbsolute(worktreeRoot, record.path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new DocumentStoreError(
      "DOCUMENT_CONTENT_MISSING",
      "Ledger references a missing local blob; re-upload the same SHA-256 to heal.",
      404,
    );
  }
  const bytes = readFileSync(absolute);
  if (bytes.byteLength !== record.bytes) {
    throw new DocumentStoreError(
      "DOCUMENT_CONTENT_MISSING",
      "On-disk document size drifted from the ledger; re-upload heals by SHA.",
      404,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== record.sha256) {
    throw new DocumentStoreError(
      "DOCUMENT_CONTENT_MISSING",
      "On-disk document digest drifted from the ledger; re-upload heals by SHA.",
      404,
    );
  }
  return bytes;
}

export function emptyCache(state: "fresh" | "stale" | "empty" = "fresh") {
  return {
    state,
    asOf: new Date().toISOString(),
    message: null,
    acceptedGenerationId: null,
    baseRevision: 0,
  };
}

export function documentSummaryFields(
  record: DocumentRecord,
): Record<string, JsonValue> {
  return {
    sha256: record.sha256,
    path: record.path,
    docKind: record.kind,
    mimeType: record.mimeType,
    bytes: record.bytes,
    withdrawn: record.withdrawn,
    needsOcr: record.needsOcr,
    uploadedAt: record.uploadedAt,
    retention: "plugin-local",
  };
}

export function writeFixtureDocument(
  worktreeRoot: string,
  sha256: string,
  name: string,
  bytes: Buffer,
): string {
  const relativePath = documentRelativePath(sha256, name);
  const absolute = confinedAbsolute(worktreeRoot, relativePath);
  mkdirSync(confinedAbsolute(worktreeRoot, DOCUMENTS_DIRECTORY), {
    recursive: true,
  });
  writeFileSync(absolute, bytes);
  return relativePath;
}

export function unusedRandomId(): string {
  return randomUUID();
}
