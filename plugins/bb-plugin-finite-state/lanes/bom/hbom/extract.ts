import type Database from "better-sqlite3";

import {
  HUMAN_APPROVAL_CAPABILITY_POLICY,
  documentSourceRefSchema,
  type DocumentSourceRef,
  type HumanApprovalCapability,
  type JsonValue,
} from "../../../shared/contract.js";
import { toStorageProjectVersionId } from "../../../lib/store/index.js";
import { encodeSourceRef } from "../../documents/source-ref.js";
import { isHbomPartField } from "./cell-view.js";
import { mergeProposalIntoCell, type MergeOutcomeKind } from "./merge.js";
import { createDocumentLedgerLookup, rebuildHbomMirror } from "./mirror.js";
import {
  HBOM_SOURCE_REF_TEXT_FORBIDDEN,
  HbomValidationError,
  parseHbomDocument,
} from "./schema.js";
import {
  HBOM_CATEGORIES,
  HBOM_LIFECYCLE_STATUSES,
  HBOM_PART_FIELDS,
  HBOM_RELATIVE_PATH,
  type HbomCell,
  type HbomDocument,
  type HbomPart,
  type HbomPartField,
  type HbomProvenance,
} from "./types.js";
import {
  emptyHbomDocument,
  HBOM_EMPTY_SHA256,
  HbomMissingError,
  HbomStaleError,
  readHbom,
  writeHbomCas,
} from "./yaml.js";

export const HBOM_EXTRACTION_MAX_PROPOSALS = 500 as const;

export type HbomField = HbomPartField;

export interface HbomProposal {
  part: { id: string } | { mpn?: string; referenceDesignator?: string };
  field: HbomField;
  value: unknown;
  sourceRef: DocumentSourceRef;
  confidence: number;
}

export interface ExtractionRequest {
  documentSha256: string;
  expectedHbomSha256: string;
  proposals: HbomProposal[];
  createMissingParts: boolean;
}

export interface ExtractionResult {
  path: typeof HBOM_RELATIVE_PATH;
  hbomSha256: string;
  merged: number;
  queued: number;
  conflicts: number;
  candidatesAdded: number;
  rejected: Array<{ index: number; code: string; message: string }>;
  diffSummary: string;
}

/** Server-derived extractor identity. Never accepted from client proposal bodies. */
export interface AgentActor {
  id: string;
  at?: string;
}

export interface ExtractionDeps {
  db: Database.Database;
  root: string;
  projectId: string;
  projectVersionId: string | null;
  now?: () => string;
}

export class HbomExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HbomExtractionError";
  }
}

interface DocumentMeta {
  kind: string;
  needsOcr: boolean;
  withdrawn: boolean;
  present: boolean;
}

function storageScope(
  projectId: string,
  projectVersionId: string | null,
): { projectId: string; projectVersionId: string } {
  return {
    projectId,
    projectVersionId: toStorageProjectVersionId(projectVersionId),
  };
}

function lookupDocument(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string },
  sha256: string,
): DocumentMeta {
  const row: unknown = db
    .prepare(
      `SELECT doc_kind AS kind, needs_ocr AS needsOcr, withdrawn
         FROM document
        WHERE project_id = ? AND project_version_id = ? AND sha256 = ?
        LIMIT 1`,
    )
    .get(scope.projectId, scope.projectVersionId, sha256);
  if (typeof row !== "object" || row === null) {
    return { kind: "", needsOcr: false, withdrawn: false, present: false };
  }
  const kind = Reflect.get(row, "kind");
  const needsOcr = Reflect.get(row, "needsOcr");
  const withdrawn = Reflect.get(row, "withdrawn");
  if (typeof kind !== "string") {
    return { kind: "", needsOcr: false, withdrawn: false, present: false };
  }
  return {
    kind,
    needsOcr: needsOcr === 1,
    withdrawn: withdrawn === 1,
    present: true,
  };
}

export function provenanceForDocumentKind(
  kind: string,
): Exclude<HbomProvenance, "human"> {
  switch (kind) {
    case "datasheet":
      return "datasheet";
    case "bom":
      return "bom_import";
    case "schematic":
      return "schematic";
    case "other":
      return "vendor";
    default:
      return "inferred";
  }
}

function cellForField(
  part: HbomPart,
  field: HbomPartField,
): HbomCell<unknown> | undefined {
  return part[field];
}

function setCellForField(
  part: HbomPart,
  field: HbomPartField,
  cell: HbomCell<unknown>,
): void {
  Reflect.set(part, field, cell);
}

function cloneCell<T>(cell: HbomCell<T>): HbomCell<T> {
  return {
    value: cell.value,
    ...(cell.provenance !== undefined ? { provenance: cell.provenance } : {}),
    ...(cell.sourceRef !== undefined ? { sourceRef: cell.sourceRef } : {}),
    ...(cell.confidence !== undefined ? { confidence: cell.confidence } : {}),
    ...(cell.by !== undefined ? { by: cell.by } : {}),
    ...(cell.at !== undefined ? { at: cell.at } : {}),
    ...(cell.note !== undefined ? { note: cell.note } : {}),
    ...(cell.accepted !== undefined ? { accepted: { ...cell.accepted } } : {}),
    ...(cell.candidates !== undefined
      ? {
          candidates: cell.candidates.map((candidate) => ({
            ...candidate,
            ...(candidate.sourceRef !== undefined
              ? { sourceRef: candidate.sourceRef }
              : {}),
          })),
        }
      : {}),
  };
}

function cloneDocument(document: HbomDocument): HbomDocument {
  return {
    schema: document.schema,
    project: document.project,
    ...(document.asProjectId !== undefined
      ? { asProjectId: document.asProjectId }
      : {}),
    options: { ...document.options },
    parts: document.parts.map((part) => {
      const next: HbomPart = {
        id: part.id,
        asComponentId: part.asComponentId,
        ...(part.boardRevision !== undefined
          ? { boardRevision: part.boardRevision }
          : {}),
        ...(part.asMissing !== undefined ? { asMissing: part.asMissing } : {}),
        ...(part.externalRefs !== undefined
          ? { externalRefs: part.externalRefs.map((ref) => ({ ...ref })) }
          : {}),
      };
      for (const field of HBOM_PART_FIELDS) {
        const cell = cellForField(part, field);
        if (cell !== undefined) setCellForField(next, field, cloneCell(cell));
      }
      return next;
    }),
  };
}

function nextPartId(parts: readonly HbomPart[]): string {
  let max = 0;
  for (const part of parts) {
    const match = /^HBOM-(\d+)$/u.exec(part.id);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `HBOM-${String(max + 1).padStart(4, "0")}`;
}

function partHasId(
  part: { id: string } | { mpn?: string; referenceDesignator?: string },
): part is { id: string } {
  return "id" in part && typeof part.id === "string";
}

function findPart(
  document: HbomDocument,
  identity: HbomProposal["part"],
): HbomPart | undefined {
  if (partHasId(identity)) {
    return document.parts.find((part) => part.id === identity.id);
  }
  const mpn = identity.mpn?.trim();
  const refDes = identity.referenceDesignator?.trim();
  if (mpn === undefined && refDes === undefined) return undefined;
  return document.parts.find((part) => {
    if (mpn !== undefined && part.mpn?.value === mpn) return true;
    if (refDes !== undefined) {
      const refs = part.referenceDesignators?.value;
      if (Array.isArray(refs) && refs.includes(refDes)) return true;
    }
    return false;
  });
}

function isCategory(value: string): boolean {
  for (const known of HBOM_CATEGORIES) {
    if (known === value) return true;
  }
  return false;
}

function isLifecycle(value: string): boolean {
  for (const known of HBOM_LIFECYCLE_STATUSES) {
    if (known === value) return true;
  }
  return false;
}

function validateFieldValue(
  field: HbomPartField,
  value: unknown,
): string | null {
  if (value === null) return null;
  switch (field) {
    case "partNumber":
    case "mpn":
    case "manufacturer":
    case "description":
    case "supplier":
    case "countryOfOrigin":
    case "securityRelevance":
    case "firmwareLink":
      if (typeof value !== "string" || value.length > 10_000) {
        return `${field} must be a string (or null)`;
      }
      return null;
    case "category":
      if (typeof value !== "string" || !isCategory(value)) {
        return `category must be one of ${HBOM_CATEGORIES.join(", ")}`;
      }
      return null;
    case "quantity":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return "quantity must be a non-negative integer (or null)";
      }
      return null;
    case "referenceDesignators":
    case "complianceFlags":
      if (
        !Array.isArray(value) ||
        value.length > 500 ||
        value.some(
          (item) =>
            typeof item !== "string" ||
            item.trim().length < 1 ||
            item.length > 200,
        )
      ) {
        return `${field} must be an array of non-empty strings (or null)`;
      }
      return null;
    case "lifecycleStatus":
      if (typeof value !== "string" || !isLifecycle(value)) {
        return `lifecycleStatus must be one of ${HBOM_LIFECYCLE_STATUSES.join(", ")}`;
      }
      return null;
    case "fccCoveredList":
    case "cryptoRelevant":
      if (typeof value !== "boolean") {
        return `${field} must be a boolean (or null)`;
      }
      return null;
  }
}

function reject(
  index: number,
  code: string,
  message: string,
): { index: number; code: string; message: string } {
  return { index, code, message };
}

function validateProposalSource(
  sourceRef: DocumentSourceRef,
  documentSha256: string,
  doc: DocumentMeta,
  ledger: (sha: string) => boolean,
): { code: string; message: string } | null {
  const parsed = documentSourceRefSchema.safeParse(sourceRef);
  if (!parsed.success) {
    return {
      code: "HBOM_SOURCE_REF_INVALID",
      message: "sourceRef failed DocumentSourceRef validation",
    };
  }
  if (parsed.data.documentSha256 !== documentSha256) {
    return {
      code: "HBOM_SOURCE_REF_DOCUMENT_MISMATCH",
      message:
        "sourceRef.documentSha256 must equal the extraction batch documentSha256",
    };
  }
  if (!doc.present || !ledger(documentSha256)) {
    return {
      code: "HBOM_DOCUMENT_UNREGISTERED",
      message: "source document is not registered in the document ledger",
    };
  }
  if (doc.withdrawn) {
    return {
      code: "HBOM_DOCUMENT_WITHDRAWN",
      message: "source document has been withdrawn",
    };
  }
  if (doc.needsOcr) {
    return {
      code: "HBOM_SOURCE_IMAGE_ONLY",
      message:
        "image-only documents without OCR coordinates are not acceptable evidence",
    };
  }
  if (parsed.data.locator.kind === "text") {
    return {
      code: HBOM_SOURCE_REF_TEXT_FORBIDDEN,
      message:
        "document-backed provenance requires a pdf page/region or sheet/cell citation; text locators are not accepted",
    };
  }
  try {
    encodeSourceRef(parsed.data);
  } catch {
    return {
      code: "HBOM_SOURCE_REF_INVALID",
      message: "sourceRef locator is not encodable",
    };
  }
  return null;
}

function countOutcome(
  kind: MergeOutcomeKind,
  counters: {
    merged: number;
    queued: number;
    conflicts: number;
    candidatesAdded: number;
  },
  queued: boolean,
): void {
  if (kind === "merged" || kind === "corroborated") counters.merged += 1;
  if (kind === "conflict") counters.conflicts += 1;
  if (kind === "candidate" || kind === "conflict")
    counters.candidatesAdded += 1;
  if (queued) counters.queued += 1;
}

function summarizeDiff(
  before: HbomDocument,
  after: HbomDocument,
  counters: {
    merged: number;
    queued: number;
    conflicts: number;
    candidatesAdded: number;
    rejected: number;
  },
): string {
  const beforeParts = before.parts.length;
  const afterParts = after.parts.length;
  return [
    `merged=${counters.merged}`,
    `queued=${counters.queued}`,
    `conflicts=${counters.conflicts}`,
    `candidatesAdded=${counters.candidatesAdded}`,
    `rejected=${counters.rejected}`,
    `parts ${beforeParts}→${afterParts}`,
  ].join("; ");
}

/**
 * Validate and merge an extraction batch. Partial success: invalid items are
 * reported individually; valid changes CAS-write once. Actor stamps by/at —
 * callers cannot set human provenance or acceptance.
 */
export async function applyHbomExtraction(
  deps: ExtractionDeps,
  actor: AgentActor,
  request: ExtractionRequest,
): Promise<ExtractionResult> {
  if (actor.id.trim().length < 1) {
    throw new HbomExtractionError(
      "HBOM_ACTOR_REQUIRED",
      "Extractor actor identity is required.",
    );
  }
  if (request.proposals.length > HBOM_EXTRACTION_MAX_PROPOSALS) {
    throw new HbomExtractionError(
      "HBOM_EXTRACTION_BATCH_TOO_LARGE",
      `Extraction batches are capped at ${HBOM_EXTRACTION_MAX_PROPOSALS} proposals.`,
    );
  }

  const scope = storageScope(deps.projectId, deps.projectVersionId);
  const ledger = createDocumentLedgerLookup(deps.db, scope);
  const docMeta = lookupDocument(deps.db, scope, request.documentSha256);
  const provenance = provenanceForDocumentKind(docMeta.kind);
  const at = actor.at ?? deps.now?.() ?? new Date().toISOString();

  let read;
  try {
    read = await readHbom(deps.root, { ledger });
  } catch (error) {
    if (error instanceof HbomMissingError) {
      read = {
        document: emptyHbomDocument(deps.projectId),
        sha256: HBOM_EMPTY_SHA256,
        text: "",
      };
      if (request.expectedHbomSha256 !== read.sha256) {
        throw new HbomStaleError(request.expectedHbomSha256, read.sha256);
      }
    } else {
      throw error;
    }
  }

  if (read.sha256 !== request.expectedHbomSha256) {
    throw new HbomStaleError(request.expectedHbomSha256, read.sha256);
  }

  const next = cloneDocument(read.document);
  const rejected: ExtractionResult["rejected"] = [];
  const counters = {
    merged: 0,
    queued: 0,
    conflicts: 0,
    candidatesAdded: 0,
  };
  let applied = 0;

  for (let index = 0; index < request.proposals.length; index += 1) {
    const proposal = request.proposals[index]!;

    if (!isHbomPartField(proposal.field)) {
      rejected.push(
        reject(
          index,
          "HBOM_FIELD_INVALID",
          `Unknown HBOM field ${proposal.field}`,
        ),
      );
      continue;
    }

    if (
      typeof proposal.confidence !== "number" ||
      proposal.confidence < 0 ||
      proposal.confidence > 1
    ) {
      rejected.push(
        reject(
          index,
          "HBOM_CONFIDENCE_INVALID",
          "confidence must be a number in [0, 1]",
        ),
      );
      continue;
    }

    const sourceError = validateProposalSource(
      proposal.sourceRef,
      request.documentSha256,
      docMeta,
      ledger,
    );
    if (sourceError !== null) {
      rejected.push(reject(index, sourceError.code, sourceError.message));
      continue;
    }

    const valueError = validateFieldValue(proposal.field, proposal.value);
    if (valueError !== null) {
      rejected.push(reject(index, "HBOM_VALUE_INVALID", valueError));
      continue;
    }

    let part = findPart(next, proposal.part);
    if (part === undefined) {
      if (!request.createMissingParts) {
        rejected.push(
          reject(
            index,
            "HBOM_PART_NOT_FOUND",
            "Part was not found and createMissingParts is false",
          ),
        );
        continue;
      }
      if (partHasId(proposal.part)) {
        part = {
          id: proposal.part.id,
          asComponentId: null,
        };
      } else {
        part = {
          id: nextPartId(next.parts),
          asComponentId: null,
        };
        if (proposal.part.mpn !== undefined) {
          part.mpn = {
            value: proposal.part.mpn,
            provenance,
            sourceRef: proposal.sourceRef,
            confidence: proposal.confidence,
            by: actor.id,
            at,
          };
        }
        if (proposal.part.referenceDesignator !== undefined) {
          part.referenceDesignators = {
            value: [proposal.part.referenceDesignator],
            provenance,
            sourceRef: proposal.sourceRef,
            confidence: proposal.confidence,
            by: actor.id,
            at,
          };
        }
      }
      // Reject fabricated human-looking ids that don't match the schema.
      if (!/^HBOM-[0-9]{4,}$/u.test(part.id)) {
        rejected.push(
          reject(index, "HBOM_PART_ID_INVALID", "part id must match HBOM-NNNN"),
        );
        continue;
      }
      next.parts.push(part);
    }

    const existing = cellForField(part, proposal.field);
    const outcome = mergeProposalIntoCell(
      existing,
      {
        value: proposal.value,
        provenance,
        sourceRef: proposal.sourceRef,
        confidence: proposal.confidence,
        by: actor.id,
        at,
      },
      next.options.reviewThreshold,
    );
    setCellForField(part, proposal.field, outcome.cell);
    countOutcome(outcome.kind, counters, outcome.queued);
    applied += 1;
  }

  if (applied === 0) {
    return {
      path: HBOM_RELATIVE_PATH,
      hbomSha256: read.sha256,
      merged: 0,
      queued: 0,
      conflicts: 0,
      candidatesAdded: 0,
      rejected,
      diffSummary: summarizeDiff(read.document, read.document, {
        ...counters,
        rejected: rejected.length,
      }),
    };
  }

  // Round-trip validate before CAS so a bad merge cannot land.
  try {
    parseHbomDocument(
      {
        schema: next.schema,
        project: next.project,
        ...(next.asProjectId !== undefined
          ? { asProjectId: next.asProjectId }
          : {}),
        options: next.options,
        parts: next.parts,
      },
      { ledger, file: HBOM_RELATIVE_PATH },
    );
  } catch (error) {
    if (error instanceof HbomValidationError) {
      throw new HbomExtractionError(error.code, error.message);
    }
    throw error;
  }

  const hbomSha256 = await writeHbomCas(
    deps.root,
    request.expectedHbomSha256,
    next,
    { ledger },
  );
  rebuildHbomMirror(deps.db, next, {
    ...scope,
    fileSha256: hbomSha256,
  });

  return {
    path: HBOM_RELATIVE_PATH,
    hbomSha256,
    merged: counters.merged,
    queued: counters.queued,
    conflicts: counters.conflicts,
    candidatesAdded: counters.candidatesAdded,
    rejected,
    diffSummary: summarizeDiff(read.document, next, {
      ...counters,
      rejected: rejected.length,
    }),
  };
}

export interface ApplyHbomExtractionRpcInput {
  projectId: string;
  projectVersionId: string | null;
  humanApprovalCapability: HumanApprovalCapability;
  documentSha256: string;
  expectedHbomSha256: string;
  proposals: Array<{
    partKey: string;
    field: string;
    value: JsonValue;
    sourceRef: DocumentSourceRef;
    confidence: number;
  }>;
  createMissingParts: boolean;
}

/**
 * Frozen human-only RPC surface. v1 has no actor-authenticated capability mint,
 * so this always fails closed before any CAS/YAML side effect. WP-59 registers
 * the pure {@link applyHbomExtraction} service as `fs_hbom_extract`.
 */
export function applyHbomExtractionRpc(
  _deps: ExtractionDeps,
  _input: ApplyHbomExtractionRpcInput,
): never {
  throw new HbomExtractionError(
    "HBOM_EXTRACTION_AUTHORIZATION_UNAVAILABLE",
    `HBOM extraction apply ${HUMAN_APPROVAL_CAPABILITY_POLICY.handlerDisposition} until bb can mint and verify an actor-authenticated human approval capability`,
  );
}
