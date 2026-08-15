import type Database from "better-sqlite3";

import {
  HUMAN_APPROVAL_CAPABILITY_POLICY,
  type DocumentSourceRef,
  type HumanApprovalCapability,
  type JsonValue,
} from "../../../shared/contract.js";
import {
  toStorageProjectVersionId,
  type HbomCandidateRow,
  type HbomCellRow,
} from "../../../lib/store/index.js";
import {
  decodeSourceRef,
  encodeSourceRef,
} from "../../documents/source-ref.js";
import {
  confidenceBand,
  isHbomPartField,
  reviewCellId,
  type HbomCellView,
  type ReviewReason,
} from "./cell-view.js";
import { createDocumentLedgerLookup, rebuildHbomMirror } from "./mirror.js";
import { deriveHbomCellState } from "./schema.js";
import {
  HBOM_PART_FIELDS,
  type HbomCandidate,
  type HbomCell,
  type HbomDocument,
  type HbomPart,
  type HbomPartField,
} from "./types.js";
import {
  HbomMissingError,
  HbomStaleError,
  readHbom,
  writeHbomCas,
} from "./yaml.js";

export {
  confidenceBand,
  isHbomPartField,
  parseReviewCellId,
  reviewCellId,
  type ConfidenceBand,
  type HbomCellView,
  type ReviewReason,
} from "./cell-view.js";

export type ReviewDecision =
  | {
      action: "accept";
      partId: string;
      field: string;
      candidateIndex?: number;
    }
  | {
      action: "reject";
      partId: string;
      field: string;
      candidateIndex?: number;
    }
  | {
      action: "edit";
      partId: string;
      field: string;
      value: unknown;
      note?: string;
    };

export interface ReviewRequest {
  projectId: string;
  projectVersionId: string | null;
  humanApprovalCapability: HumanApprovalCapability;
  expectedHbomSha256: string;
  decisions: ReviewDecision[];
}

export interface ReviewResult {
  hbomSha256: string;
  applied: number;
  rejected: Array<{ index: number; code: string; message: string }>;
}

/** Server-derived actor. Never accepted from the client. */
export interface AuthenticatedActor {
  id: string;
  at: string;
}

export interface ReviewDeps {
  db: Database.Database;
  root: string;
  now?: () => string;
}

export class HbomReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HbomReviewError";
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
  cell: HbomCell<unknown> | undefined,
): void {
  if (cell === undefined) {
    Reflect.deleteProperty(part, field);
    return;
  }
  Reflect.set(part, field, cell);
}

function decodeJsonValue(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function tryDecodeSourceRef(raw: string | null): DocumentSourceRef | null {
  if (raw === null || raw.length === 0) return null;
  try {
    return decodeSourceRef(raw);
  } catch {
    return null;
  }
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

function documentWithdrawn(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string },
  documentSha256: string,
): boolean {
  const row = db
    .prepare(
      `SELECT withdrawn FROM document
        WHERE project_id = ? AND project_version_id = ? AND sha256 = ?
        LIMIT 1`,
    )
    .get(scope.projectId, scope.projectVersionId, documentSha256) as
    | { withdrawn: number }
    | undefined;
  return row !== undefined && row.withdrawn === 1;
}

function documentExists(
  db: Database.Database,
  scope: { projectId: string; projectVersionId: string },
  documentSha256: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM document
        WHERE project_id = ? AND project_version_id = ? AND sha256 = ?
        LIMIT 1`,
    )
    .get(scope.projectId, scope.projectVersionId, documentSha256);
  return row !== undefined;
}

export function reviewReasonForCell(
  cell: HbomCellView,
  reviewThreshold: number,
  options: {
    documentMissing: boolean;
    documentWithdrawn: boolean;
  },
): ReviewReason | null {
  if (cell.state === "verified" || cell.state === "not_applicable") return null;
  if (cell.state === "unknown") return null;
  if (cell.state === "conflict") return "conflict";
  if (options.documentWithdrawn) return "withdrawn_source";
  if (options.documentMissing) return "incomplete_source";
  if (cell.confidence !== null && cell.confidence < reviewThreshold) {
    return "low_confidence";
  }
  if (cell.state === "proposal") return "proposal";
  return null;
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

export interface ProjectedHbom {
  document: HbomDocument;
  sha256: string;
  cache: {
    state: "fresh" | "stale" | "empty";
    asOf: string | null;
    message: string | null;
    acceptedGenerationId: string | null;
    baseRevision: number;
  };
}

/**
 * Read authoritative YAML and rebuild disposable mirrors. Missing file yields
 * an empty projection so the UI can render its empty state.
 */
export async function projectHbom(
  deps: ReviewDeps,
  projectId: string,
  projectVersionId: string | null,
): Promise<ProjectedHbom> {
  const scope = storageScope(projectId, projectVersionId);
  const ledger = createDocumentLedgerLookup(deps.db, scope);
  try {
    const read = await readHbom(deps.root, { ledger });
    rebuildHbomMirror(deps.db, read.document, {
      ...scope,
      fileSha256: read.sha256,
    });
    return {
      document: read.document,
      sha256: read.sha256,
      cache: {
        state: "fresh",
        asOf: new Date().toISOString(),
        message: null,
        acceptedGenerationId: null,
        baseRevision: 0,
      },
    };
  } catch (error) {
    if (error instanceof HbomMissingError) {
      return {
        document: {
          schema: "fs-hbom/v1",
          project: projectId,
          options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
          parts: [],
        },
        sha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        cache: {
          state: "empty",
          asOf: null,
          message:
            "No product-security/hbom/hbom.yaml yet. Seed or ingest first.",
          acceptedGenerationId: null,
          baseRevision: 0,
        },
      };
    }
    throw error;
  }
}

function cellViewFromPart(
  part: HbomPart,
  field: HbomPartField,
): HbomCellView | null {
  const cell = cellForField(part, field);
  if (cell === undefined) return null;
  return {
    partId: part.id,
    field,
    value: cell.value,
    state: deriveHbomCellState(cell),
    confidence: cell.confidence ?? null,
    sourceRef: cell.sourceRef ?? null,
    acceptedBy: cell.accepted?.by ?? null,
    acceptedAt: cell.accepted?.at ?? null,
    candidateCount: cell.candidates?.length ?? 0,
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toJsonValue(entry);
    }
    return record;
  }
  return String(value);
}

function sourceRefFields(ref: DocumentSourceRef | null): JsonValue {
  if (ref === null) return null;
  return {
    documentSha256: ref.documentSha256,
    encoded: encodeSourceRef(ref),
    locator: toJsonValue(ref.locator),
  };
}

export interface ListHbomReviewInput {
  projectId: string;
  projectVersionId: string | null;
  pageSize: number;
  continuation: string | null;
  filters: Record<string, JsonValue>;
}

function filterString(
  filters: Record<string, JsonValue>,
  key: string,
): string | undefined {
  const value = filters[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function filterNumber(
  filters: Record<string, JsonValue>,
  key: string,
): number | undefined {
  const value = filters[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function buildQueueItems(
  deps: ReviewDeps,
  projected: ProjectedHbom,
  projectId: string,
  projectVersionId: string | null,
  filters: Record<string, JsonValue>,
): Array<{
  projectId: string;
  projectVersionId: string | null;
  kind: string;
  key: string;
  label: string;
  fields: Record<string, JsonValue>;
}> {
  const scope = storageScope(projectId, projectVersionId);
  const documentFilter = filterString(filters, "document");
  const fieldFilter = filterString(filters, "field");
  const provenanceFilter = filterString(filters, "provenance");
  const reasonFilter = filterString(filters, "reason");
  const minConfidence = filterNumber(filters, "minConfidence");
  const maxConfidence = filterNumber(filters, "maxConfidence");
  const items: Array<{
    projectId: string;
    projectVersionId: string | null;
    kind: string;
    key: string;
    label: string;
    fields: Record<string, JsonValue>;
  }> = [];

  for (const part of projected.document.parts) {
    for (const field of HBOM_PART_FIELDS) {
      const view = cellViewFromPart(part, field);
      if (view === null) continue;
      const cell = cellForField(part, field)!;
      const sourceMissing =
        view.sourceRef !== null &&
        !documentExists(deps.db, scope, view.sourceRef.documentSha256);
      const sourceWithdrawn =
        view.sourceRef !== null &&
        documentWithdrawn(deps.db, scope, view.sourceRef.documentSha256);
      const reason = reviewReasonForCell(
        view,
        projected.document.options.reviewThreshold,
        {
          documentMissing: sourceMissing,
          documentWithdrawn: sourceWithdrawn,
        },
      );
      if (reason === null) continue;
      if (fieldFilter && field !== fieldFilter) continue;
      if (provenanceFilter && cell.provenance !== provenanceFilter) continue;
      if (reasonFilter && reason !== reasonFilter) continue;
      if (
        documentFilter &&
        (view.sourceRef === null ||
          view.sourceRef.documentSha256 !== documentFilter)
      ) {
        continue;
      }
      if (
        minConfidence !== undefined &&
        (view.confidence === null || view.confidence < minConfidence)
      ) {
        continue;
      }
      if (
        maxConfidence !== undefined &&
        (view.confidence === null || view.confidence > maxConfidence)
      ) {
        continue;
      }

      const candidates = (cell.candidates ?? []).map((candidate, index) => ({
        index,
        value: toJsonValue(candidate.value),
        provenance: candidate.provenance,
        confidence: candidate.confidence,
        by: candidate.by,
        at: candidate.at,
        sourceRef: sourceRefFields(candidate.sourceRef ?? null),
      }));

      items.push({
        projectId,
        projectVersionId,
        kind: "hbomReviewCell",
        key: reviewCellId(part.id, field),
        label: `${part.id} · ${field}`,
        fields: {
          partId: part.id,
          field,
          value: toJsonValue(view.value),
          state: view.state,
          confidence: view.confidence,
          band: confidenceBand(view.state, view.confidence),
          reason,
          provenance: cell.provenance ?? null,
          sourceRef: sourceRefFields(view.sourceRef),
          acceptedBy: view.acceptedBy,
          acceptedAt: view.acceptedAt,
          candidateCount: view.candidateCount,
          candidates,
          hbomSha256: projected.sha256,
          reviewThreshold: projected.document.options.reviewThreshold,
          asComponentId: part.asComponentId,
        },
      });
    }
  }
  return items;
}

function buildPartItems(
  projected: ProjectedHbom,
  projectId: string,
  projectVersionId: string | null,
): Array<{
  projectId: string;
  projectVersionId: string | null;
  kind: string;
  key: string;
  label: string;
  fields: Record<string, JsonValue>;
}> {
  let verified = 0;
  let total = 0;
  let queueDepth = 0;
  const items = projected.document.parts.map((part) => {
    const cells: Record<string, JsonValue> = {};
    let partVerified = 0;
    let partTotal = 0;
    let partConflicts = 0;
    for (const field of HBOM_PART_FIELDS) {
      const view = cellViewFromPart(part, field);
      if (view === null) continue;
      partTotal += 1;
      total += 1;
      if (view.state === "verified" || view.state === "not_applicable") {
        partVerified += 1;
        verified += 1;
      }
      if (view.state === "proposal" || view.state === "conflict") {
        if (
          view.state === "conflict" ||
          (view.confidence !== null &&
            view.confidence < projected.document.options.reviewThreshold) ||
          view.state === "proposal"
        ) {
          queueDepth += 1;
        }
      }
      if (view.state === "conflict") partConflicts += 1;
      cells[field] = {
        value: toJsonValue(view.value),
        state: view.state,
        confidence: view.confidence,
        band: confidenceBand(view.state, view.confidence),
        sourceRef: sourceRefFields(view.sourceRef),
        acceptedBy: view.acceptedBy,
        acceptedAt: view.acceptedAt,
        candidateCount: view.candidateCount,
      };
    }
    const labelCell =
      cellForField(part, "partNumber") ?? cellForField(part, "mpn");
    const fields: Record<string, JsonValue> = {
      partId: part.id,
      asComponentId: part.asComponentId,
      asMissing: part.asMissing === true,
      boardRevision: part.boardRevision ?? null,
      cells,
      cellCount: partTotal,
      verifiedCount: partVerified,
      conflictCount: partConflicts,
      completeness: partTotal === 0 ? 0 : partVerified / partTotal,
      hbomSha256: projected.sha256,
      reviewThreshold: projected.document.options.reviewThreshold,
      externalRefs: toJsonValue(part.externalRefs ?? []),
    };
    return {
      projectId,
      projectVersionId,
      kind: "hbomPart",
      key: part.id,
      label:
        typeof labelCell?.value === "string" && labelCell.value.length > 0
          ? labelCell.value
          : part.id,
      fields,
    };
  });

  // Attach aggregate on every page via cache message is awkward; include a
  // synthetic summary when view=parts is empty so callers still get counts.
  if (items.length === 0) {
    items.push({
      projectId,
      projectVersionId,
      kind: "hbomSummary",
      key: "summary",
      label: "HBOM summary",
      fields: {
        partCount: 0,
        cellCount: 0,
        verifiedCount: 0,
        verifiedRatio: 0,
        queueDepth: 0,
        hbomSha256: projected.sha256,
        reviewThreshold: projected.document.options.reviewThreshold,
      },
    });
  } else {
    for (const item of items) {
      item.fields.partCount = projected.document.parts.length;
      item.fields.verifiedRatio = total === 0 ? 0 : verified / total;
      item.fields.queueDepth = queueDepth;
      item.fields.cellCount = total;
      item.fields.verifiedCount = verified;
    }
  }
  return items;
}

function buildSummaryItem(
  projected: ProjectedHbom,
  projectId: string,
  projectVersionId: string | null,
  queueDepth: number,
): {
  projectId: string;
  projectVersionId: string | null;
  kind: string;
  key: string;
  label: string;
  fields: Record<string, JsonValue>;
} {
  let verified = 0;
  let total = 0;
  for (const part of projected.document.parts) {
    for (const field of HBOM_PART_FIELDS) {
      const view = cellViewFromPart(part, field);
      if (view === null) continue;
      total += 1;
      if (view.state === "verified" || view.state === "not_applicable") {
        verified += 1;
      }
    }
  }
  return {
    projectId,
    projectVersionId,
    kind: "hbomSummary",
    key: "summary",
    label: "HBOM summary",
    fields: {
      partCount: projected.document.parts.length,
      cellCount: total,
      verifiedCount: verified,
      verifiedRatio: total === 0 ? 0 : verified / total,
      queueDepth,
      hbomSha256: projected.sha256,
      reviewThreshold: projected.document.options.reviewThreshold,
      exportThreshold: projected.document.options.exportThreshold,
      asProjectId: projected.document.asProjectId ?? null,
      project: projected.document.project,
    },
  };
}

function paginate<T>(
  items: T[],
  pageSize: number,
  continuation: string | null,
): { page: T[]; next: string | null; total: number } {
  const offset =
    continuation && /^\d+$/u.test(continuation) ? Number(continuation) : 0;
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    page,
    next: nextOffset < items.length ? String(nextOffset) : null,
    total: items.length,
  };
}

export async function listHbomReview(
  deps: ReviewDeps,
  input: ListHbomReviewInput,
) {
  const projected = await projectHbom(
    deps,
    input.projectId,
    input.projectVersionId,
  );
  const view = filterString(input.filters, "view") ?? "queue";
  let items;
  if (view === "summary") {
    const queue = buildQueueItems(
      deps,
      projected,
      input.projectId,
      input.projectVersionId,
      {},
    );
    items = [
      buildSummaryItem(
        projected,
        input.projectId,
        input.projectVersionId,
        queue.length,
      ),
    ];
  } else if (view === "parts") {
    items = buildPartItems(projected, input.projectId, input.projectVersionId);
  } else {
    items = buildQueueItems(
      deps,
      projected,
      input.projectId,
      input.projectVersionId,
      input.filters,
    );
  }
  const page = paginate(items, input.pageSize, input.continuation);
  return {
    items: page.page,
    total: page.total,
    next: page.next,
    cache: projected.cache,
  };
}

export interface GetHbomComponentInput {
  projectId: string;
  projectVersionId: string | null;
  componentId: string;
}

export async function getHbomComponent(
  deps: ReviewDeps,
  input: GetHbomComponentInput,
) {
  const projected = await projectHbom(
    deps,
    input.projectId,
    input.projectVersionId,
  );
  const part = projected.document.parts.find(
    (candidate) => candidate.id === input.componentId,
  );
  if (!part) {
    throw new HbomReviewError(
      "HBOM_PART_NOT_FOUND",
      `Hardware part ${input.componentId} was not found in hbom.yaml.`,
    );
  }

  const cells: Record<string, JsonValue> = {};
  const candidates: JsonValue[] = [];
  for (const field of HBOM_PART_FIELDS) {
    const view = cellViewFromPart(part, field);
    if (view === null) continue;
    const cell = cellForField(part, field)!;
    cells[field] = {
      value: toJsonValue(view.value),
      state: view.state,
      confidence: view.confidence,
      band: confidenceBand(view.state, view.confidence),
      provenance: cell.provenance ?? null,
      sourceRef: sourceRefFields(view.sourceRef),
      acceptedBy: view.acceptedBy,
      acceptedAt: view.acceptedAt,
      by: cell.by ?? null,
      at: cell.at ?? null,
      note: cell.note ?? null,
      candidateCount: view.candidateCount,
    };
    for (const [index, candidate] of (cell.candidates ?? []).entries()) {
      candidates.push({
        field,
        index,
        value: toJsonValue(candidate.value),
        provenance: candidate.provenance,
        confidence: candidate.confidence,
        by: candidate.by,
        at: candidate.at,
        sourceRef: sourceRefFields(candidate.sourceRef ?? null),
      });
    }
  }

  const labelCell =
    cellForField(part, "partNumber") ?? cellForField(part, "mpn");
  return {
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    kind: "hbomPart",
    key: part.id,
    label:
      typeof labelCell?.value === "string" && labelCell.value.length > 0
        ? labelCell.value
        : part.id,
    fields: {
      partId: part.id,
      asComponentId: part.asComponentId,
      asMissing: part.asMissing === true,
      boardRevision: part.boardRevision ?? null,
      cells,
      candidates,
      externalRefs: toJsonValue(part.externalRefs ?? []),
      firmwareLink: toJsonValue(
        cellForField(part, "firmwareLink")?.value ?? null,
      ),
      hbomSha256: projected.sha256,
      reviewThreshold: projected.document.options.reviewThreshold,
    },
    links: [
      ...(part.asComponentId
        ? [
            {
              projectId: input.projectId,
              projectVersionId: input.projectVersionId,
              kind: "asComponent",
              key: part.asComponentId,
              label: `AS ${part.asComponentId}`,
            },
          ]
        : []),
      ...((part.externalRefs ?? []).map((ref, index) => ({
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
        kind: ref.type,
        key: `ext-${index}`,
        label: ref.url,
      })) ?? []),
    ],
    cache: projected.cache,
  };
}

function acceptIncumbent(
  cell: HbomCell<unknown>,
  actor: AuthenticatedActor,
): HbomCell<unknown> {
  const next = cloneCell(cell);
  next.accepted = { by: actor.id, at: actor.at };
  return next;
}

function acceptCandidate(
  cell: HbomCell<unknown>,
  candidateIndex: number,
  actor: AuthenticatedActor,
): HbomCell<unknown> {
  const candidates = cell.candidates ?? [];
  const chosen = candidates[candidateIndex];
  if (!chosen) {
    throw new HbomReviewError(
      "HBOM_CANDIDATE_MISSING",
      `Candidate index ${candidateIndex} is out of range.`,
    );
  }
  const demoted: HbomCandidate<unknown> = {
    value: cell.value,
    provenance:
      cell.provenance && cell.provenance !== "human"
        ? cell.provenance
        : "inferred",
    ...(cell.sourceRef !== undefined ? { sourceRef: cell.sourceRef } : {}),
    confidence: cell.confidence ?? 0,
    by: cell.by ?? "unknown",
    at: cell.at ?? actor.at,
  };
  const remaining = candidates.filter((_, index) => index !== candidateIndex);
  if (
    cell.provenance !== undefined &&
    cell.provenance !== "human" &&
    JSON.stringify(cell.value) !== JSON.stringify(chosen.value)
  ) {
    remaining.push(demoted);
  }
  return {
    value: chosen.value,
    provenance: chosen.provenance,
    ...(chosen.sourceRef !== undefined ? { sourceRef: chosen.sourceRef } : {}),
    confidence: chosen.confidence,
    by: chosen.by,
    at: chosen.at,
    accepted: { by: actor.id, at: actor.at },
    ...(remaining.length > 0 ? { candidates: remaining } : {}),
  };
}

function rejectIncumbent(
  cell: HbomCell<unknown>,
  actor: AuthenticatedActor,
): HbomCell<unknown> {
  const candidates = [...(cell.candidates ?? [])];
  if (cell.provenance !== undefined && cell.provenance !== "human") {
    candidates.unshift({
      value: cell.value,
      provenance: cell.provenance,
      ...(cell.sourceRef !== undefined ? { sourceRef: cell.sourceRef } : {}),
      confidence: cell.confidence ?? 0,
      by: cell.by ?? "unknown",
      at: cell.at ?? actor.at,
    });
  }
  // Revert to unknown bare-null; history retained in candidates.
  return {
    value: null,
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}

function rejectCandidate(
  cell: HbomCell<unknown>,
  candidateIndex: number,
): HbomCell<unknown> {
  const candidates = cell.candidates ?? [];
  if (!candidates[candidateIndex]) {
    throw new HbomReviewError(
      "HBOM_CANDIDATE_MISSING",
      `Candidate index ${candidateIndex} is out of range.`,
    );
  }
  const remaining = candidates.filter((_, index) => index !== candidateIndex);
  const next = cloneCell(cell);
  if (remaining.length === 0) delete next.candidates;
  else next.candidates = remaining;
  return next;
}

function editHuman(
  value: unknown,
  actor: AuthenticatedActor,
  note: string | undefined,
): HbomCell<unknown> {
  return {
    value: value === undefined ? null : value,
    provenance: "human",
    confidence: 1,
    by: actor.id,
    at: actor.at,
    ...(note !== undefined ? { note } : {}),
  };
}

function applyDecisionToDocument(
  document: HbomDocument,
  decision: ReviewDecision,
  actor: AuthenticatedActor,
): void {
  const part = document.parts.find(
    (candidate) => candidate.id === decision.partId,
  );
  if (!part) {
    throw new HbomReviewError(
      "HBOM_PART_NOT_FOUND",
      `Part ${decision.partId} was not found.`,
    );
  }
  if (!isHbomPartField(decision.field)) {
    throw new HbomReviewError(
      "HBOM_FIELD_INVALID",
      `Field ${decision.field} is not a known HBOM part field.`,
    );
  }
  const field = decision.field;
  const existing = cellForField(part, field) ?? { value: null };

  if (decision.action === "accept") {
    if (decision.candidateIndex !== undefined) {
      setCellForField(
        part,
        field,
        acceptCandidate(existing, decision.candidateIndex, actor),
      );
      return;
    }
    setCellForField(part, field, acceptIncumbent(existing, actor));
    return;
  }
  if (decision.action === "reject") {
    if (decision.candidateIndex !== undefined) {
      setCellForField(
        part,
        field,
        rejectCandidate(existing, decision.candidateIndex),
      );
      return;
    }
    setCellForField(part, field, rejectIncumbent(existing, actor));
    return;
  }
  setCellForField(part, field, editHuman(decision.value, actor, decision.note));
}

/**
 * Apply human review decisions through CAS. Actor and timestamps come only
 * from the authenticated actor argument — never from the request body.
 */
export async function applyHumanReview(
  deps: ReviewDeps,
  actor: AuthenticatedActor,
  request: Omit<ReviewRequest, "humanApprovalCapability">,
): Promise<ReviewResult> {
  if (actor.id.trim().length === 0) {
    throw new HbomReviewError(
      "HBOM_ACTOR_REQUIRED",
      "Authenticated actor identity is required for human review.",
    );
  }
  const scope = storageScope(request.projectId, request.projectVersionId);
  const ledger = createDocumentLedgerLookup(deps.db, scope);
  let read;
  try {
    read = await readHbom(deps.root, { ledger });
  } catch (error) {
    if (error instanceof HbomMissingError) {
      throw new HbomReviewError(
        "HBOM_MISSING",
        "hbom.yaml is missing; seed or ingest before review.",
      );
    }
    throw error;
  }

  if (read.sha256 !== request.expectedHbomSha256) {
    throw new HbomStaleError(request.expectedHbomSha256, read.sha256);
  }

  const next = cloneDocument(read.document);
  const rejected: ReviewResult["rejected"] = [];
  let applied = 0;
  for (const [index, decision] of request.decisions.entries()) {
    try {
      applyDecisionToDocument(next, decision, actor);
      applied += 1;
    } catch (error) {
      rejected.push({
        index,
        code:
          error instanceof HbomReviewError
            ? error.code
            : "HBOM_DECISION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Decision could not be applied.",
      });
    }
  }

  if (applied === 0) {
    return { hbomSha256: read.sha256, applied: 0, rejected };
  }

  try {
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
    return { hbomSha256, applied, rejected };
  } catch (error) {
    if (error instanceof HbomStaleError) throw error;
    throw error;
  }
}

export interface ResolveHbomReviewInput {
  projectId: string;
  projectVersionId: string | null;
  humanApprovalCapability: HumanApprovalCapability;
  expectedHbomSha256: string;
  decisions: Array<
    | { id: string; action: "accept"; candidateIndex?: number }
    | { id: string; action: "reject"; candidateIndex?: number }
    | { id: string; action: "edit"; value: JsonValue; note?: string }
  >;
}

/**
 * Frozen human-only RPC surface. v1 has no actor-authenticated capability mint,
 * so this always fails closed before any CAS/YAML side effect.
 */
export function resolveHbomReview(
  _deps: ReviewDeps,
  _input: ResolveHbomReviewInput,
): never {
  throw new HbomReviewError(
    "HBOM_REVIEW_AUTHORIZATION_UNAVAILABLE",
    `HBOM review resolve ${HUMAN_APPROVAL_CAPABILITY_POLICY.handlerDisposition} until bb can mint and verify an actor-authenticated human approval capability`,
  );
}

/** Map mirror rows into HbomCellView for tests and offline tooling. */
export function cellViewFromRows(
  cell: HbomCellRow,
  candidates: HbomCandidateRow[],
): HbomCellView {
  return {
    partId: cell.part_key,
    field: cell.field,
    value: decodeJsonValue(cell.value),
    state: cell.state,
    confidence: cell.confidence,
    sourceRef: tryDecodeSourceRef(cell.source_ref),
    acceptedBy: cell.accepted_by,
    acceptedAt: cell.accepted_at,
    candidateCount: candidates.length,
  };
}
