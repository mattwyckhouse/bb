import { z } from "zod";

import {
  documentSourceRefSchema,
  sha256Schema,
  type DocumentSourceRef,
} from "../../../shared/contract.js";
import { encodeSourceRef } from "../../documents/source-ref.js";
import {
  HBOM_CATEGORIES,
  HBOM_LIFECYCLE_STATUSES,
  HBOM_PART_FIELDS,
  HBOM_SCHEMA_ID,
  HBOM_SOURCE_REF_REQUIRED,
  type HbomCell,
  type HbomCellState,
  type HbomDocument,
  type HbomPart,
  type HbomPartField,
} from "./types.js";

export class HbomValidationError extends Error {
  readonly code: string;
  readonly issues: string[];

  constructor(code: string, message: string, issues: string[] = []) {
    super(message);
    this.name = "HbomValidationError";
    this.code = code;
    this.issues = issues;
  }
}

export type DocumentLedgerLookup = (documentSha256: string) => boolean;

const timestampSchema = z.string().datetime({ offset: true });
const actorSchema = z.string().trim().min(1).max(500);
const confidenceSchema = z.number().min(0).max(1);
const partIdSchema = z
  .string()
  .trim()
  .regex(/^HBOM-[0-9]{4,}$/u, "part id must match HBOM-NNNN");

const acceptanceSchema = z
  .object({
    by: actorSchema,
    at: timestampSchema,
  })
  .strict();

const externalRefSchema = z
  .object({
    type: z.string().trim().min(1).max(200),
    url: z.string().trim().min(1).max(4096),
  })
  .strict();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(`${path}: unknown field "${key}"`);
    }
  }
}

/** Document-backed cells must cite a PDF page/region or spreadsheet sheet/cell. */
export const HBOM_SOURCE_REF_TEXT_FORBIDDEN =
  "HBOM_SOURCE_REF_TEXT_FORBIDDEN" as const;

function validateSourceRef(
  ref: DocumentSourceRef,
  path: string,
  issues: string[],
  ledger: DocumentLedgerLookup | undefined,
  options: { requirePageOrSheet: boolean },
): void {
  const parsed = documentSourceRefSchema.safeParse(ref);
  if (!parsed.success) {
    issues.push(`${path}: sourceRef failed DocumentSourceRef validation`);
    return;
  }
  if (options.requirePageOrSheet && parsed.data.locator.kind === "text") {
    throw new HbomValidationError(
      HBOM_SOURCE_REF_TEXT_FORBIDDEN,
      `${path}: document-backed provenance requires a pdf page/region or sheet/cell citation; text locators are not accepted`,
      [`${path}: text locator forbidden for document-backed provenance`],
    );
  }
  try {
    encodeSourceRef(parsed.data);
  } catch {
    issues.push(`${path}: sourceRef locator is not encodable`);
    return;
  }
  if (parsed.data.locator.kind === "sheet") {
    if (
      parsed.data.locator.sheet.includes("..") ||
      parsed.data.locator.sheet.includes("/") ||
      parsed.data.locator.sheet.includes("\\")
    ) {
      issues.push(`${path}: sheet name must not contain path segments`);
    }
  }
  if (ledger && !ledger(parsed.data.documentSha256)) {
    issues.push(
      `${path}: sourceRef documentSha256 is not in the document ledger`,
    );
  }
}

function cellCandidateSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: valueSchema.nullable(),
      provenance: z.string().trim().min(1).max(200),
      sourceRef: documentSourceRefSchema.optional(),
      confidence: confidenceSchema,
      by: actorSchema,
      at: timestampSchema,
    })
    .strict()
    .superRefine((candidate, context) => {
      if (candidate.provenance === "human") {
        context.addIssue({
          code: "custom",
          message: "candidates cannot use human provenance",
        });
      }
    });
}

function cellSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: valueSchema.nullable(),
      provenance: z.string().trim().min(1).max(200).optional(),
      sourceRef: documentSourceRefSchema.optional(),
      confidence: confidenceSchema.optional(),
      by: actorSchema.optional(),
      at: timestampSchema.optional(),
      note: z.string().max(10_000).optional(),
      accepted: acceptanceSchema.optional(),
      candidates: z.array(cellCandidateSchema(valueSchema)).max(500).optional(),
    })
    .strict();
}

const stringCell = cellSchema(z.string().max(10_000));
const categoryCell = cellSchema(z.enum(HBOM_CATEGORIES));
const quantityCell = cellSchema(z.number().int().nonnegative());
const stringArrayCell = cellSchema(
  z.array(z.string().trim().min(1).max(200)).max(500),
);
const lifecycleCell = cellSchema(z.enum(HBOM_LIFECYCLE_STATUSES));
const booleanCell = cellSchema(z.boolean());

const PART_KEYS = new Set([
  "id",
  "asComponentId",
  "boardRevision",
  "asMissing",
  "partNumber",
  "mpn",
  "manufacturer",
  "description",
  "category",
  "quantity",
  "referenceDesignators",
  "lifecycleStatus",
  "supplier",
  "countryOfOrigin",
  "complianceFlags",
  "fccCoveredList",
  "cryptoRelevant",
  "securityRelevance",
  "firmwareLink",
  "externalRefs",
]);

const DOC_KEYS = new Set([
  "schema",
  "project",
  "asProjectId",
  "options",
  "parts",
]);
const OPTIONS_KEYS = new Set(["reviewThreshold", "exportThreshold"]);

type AnyCell = {
  value: unknown;
  provenance?: string;
  sourceRef?: DocumentSourceRef;
  confidence?: number;
  by?: string;
  at?: string;
  note?: string;
  accepted?: { by: string; at: string };
  candidates?: Array<{
    value: unknown;
    provenance: string;
    sourceRef?: DocumentSourceRef;
    confidence: number;
    by: string;
    at: string;
  }>;
};

function refineCell(
  cell: AnyCell,
  path: string,
  issues: string[],
  ledger: DocumentLedgerLookup | undefined,
): void {
  // Bare unknown: value is null and no provenance. Candidates may still record
  // unmerged proposals without promoting the incumbent.
  if (cell.provenance === undefined) {
    if (cell.value !== null) {
      issues.push(
        `${path}: non-bare cell requires provenance (bare null is { value: null })`,
      );
      return;
    }
    if (
      cell.confidence !== undefined ||
      cell.by !== undefined ||
      cell.at !== undefined
    ) {
      issues.push(
        `${path}: bare unknown cell cannot carry confidence/by/at without provenance`,
      );
    }
    if (cell.sourceRef !== undefined) {
      issues.push(`${path}: bare unknown cell cannot carry sourceRef`);
    }
    if (cell.accepted !== undefined) {
      issues.push(`${path}: bare unknown cell cannot carry accepted`);
    }
    if (cell.candidates !== undefined) {
      for (let index = 0; index < cell.candidates.length; index += 1) {
        const candidate = cell.candidates[index]!;
        const candidatePath = `${path}.candidates[${index}]`;
        if (candidate.provenance === "human") {
          issues.push(
            `${candidatePath}: candidates cannot use human provenance`,
          );
        }
        if (HBOM_SOURCE_REF_REQUIRED.has(candidate.provenance)) {
          if (candidate.sourceRef === undefined) {
            issues.push(
              `${candidatePath}: provenance "${candidate.provenance}" requires sourceRef`,
            );
          } else {
            validateSourceRef(
              candidate.sourceRef,
              `${candidatePath}.sourceRef`,
              issues,
              ledger,
              { requirePageOrSheet: true },
            );
          }
        } else if (candidate.sourceRef !== undefined) {
          validateSourceRef(
            candidate.sourceRef,
            `${candidatePath}.sourceRef`,
            issues,
            ledger,
            { requirePageOrSheet: false },
          );
        }
      }
    }
    return;
  }

  const provenance = cell.provenance;

  if (cell.confidence === undefined) {
    issues.push(`${path}: confidence is required when provenance is set`);
  } else if (provenance === "human" && cell.confidence !== 1) {
    issues.push(`${path}: human provenance requires confidence 1`);
  }

  if (provenance === "human") {
    if (cell.by === undefined || cell.by.length < 1) {
      issues.push(`${path}: human provenance requires by`);
    }
    if (cell.at === undefined) {
      issues.push(`${path}: human provenance requires at`);
    }
    if (cell.sourceRef !== undefined) {
      issues.push(`${path}: human provenance must not carry sourceRef`);
    }
  }

  if (HBOM_SOURCE_REF_REQUIRED.has(provenance)) {
    if (cell.sourceRef === undefined) {
      issues.push(
        `${path}: provenance "${provenance}" requires sourceRef with page/region or sheet/cell`,
      );
    } else {
      validateSourceRef(cell.sourceRef, `${path}.sourceRef`, issues, ledger, {
        requirePageOrSheet: true,
      });
    }
  } else if (cell.sourceRef !== undefined) {
    validateSourceRef(cell.sourceRef, `${path}.sourceRef`, issues, ledger, {
      requirePageOrSheet: false,
    });
  }

  if (cell.by !== undefined && cell.at === undefined) {
    issues.push(`${path}: at is required when by is set`);
  }
  if (cell.at !== undefined && cell.by === undefined) {
    issues.push(`${path}: by is required when at is set`);
  }

  if (cell.candidates !== undefined) {
    for (let index = 0; index < cell.candidates.length; index += 1) {
      const candidate = cell.candidates[index]!;
      const candidatePath = `${path}.candidates[${index}]`;
      if (candidate.provenance === "human") {
        issues.push(`${candidatePath}: candidates cannot use human provenance`);
      }
      if (HBOM_SOURCE_REF_REQUIRED.has(candidate.provenance)) {
        if (candidate.sourceRef === undefined) {
          issues.push(
            `${candidatePath}: provenance "${candidate.provenance}" requires sourceRef`,
          );
        } else {
          validateSourceRef(
            candidate.sourceRef,
            `${candidatePath}.sourceRef`,
            issues,
            ledger,
            { requirePageOrSheet: true },
          );
        }
      } else if (candidate.sourceRef !== undefined) {
        validateSourceRef(
          candidate.sourceRef,
          `${candidatePath}.sourceRef`,
          issues,
          ledger,
          { requirePageOrSheet: false },
        );
      }
    }
  }
}

function parseAndAssignCell(
  part: HbomPart,
  field: HbomPartField,
  raw: unknown,
  path: string,
  issues: string[],
  ledger: DocumentLedgerLookup | undefined,
): void {
  if (raw === undefined) return;
  if (!isPlainRecord(raw)) {
    issues.push(`${path}: cell must be an object, not a scalar`);
    return;
  }

  const fail = (error: z.ZodError): void => {
    for (const issue of error.issues) {
      const suffix = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      issues.push(`${path}${suffix}: ${issue.message}`);
    }
  };

  switch (field) {
    case "partNumber":
    case "mpn":
    case "manufacturer":
    case "description":
    case "supplier":
    case "countryOfOrigin":
    case "securityRelevance":
    case "firmwareLink": {
      const parsed = stringCell.safeParse(raw);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      refineCell(parsed.data, path, issues, ledger);
      part[field] = parsed.data;
      return;
    }
    case "category": {
      const parsed = categoryCell.safeParse(raw);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      refineCell(parsed.data, path, issues, ledger);
      part.category = parsed.data;
      return;
    }
    case "quantity": {
      const parsed = quantityCell.safeParse(raw);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      refineCell(parsed.data, path, issues, ledger);
      part.quantity = parsed.data;
      return;
    }
    case "referenceDesignators":
    case "complianceFlags": {
      const parsed = stringArrayCell.safeParse(raw);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      refineCell(parsed.data, path, issues, ledger);
      part[field] = parsed.data;
      return;
    }
    case "lifecycleStatus": {
      const parsed = lifecycleCell.safeParse(raw);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      refineCell(parsed.data, path, issues, ledger);
      part.lifecycleStatus = parsed.data;
      return;
    }
    case "fccCoveredList":
    case "cryptoRelevant": {
      const parsed = booleanCell.safeParse(raw);
      if (!parsed.success) {
        fail(parsed.error);
        return;
      }
      refineCell(parsed.data, path, issues, ledger);
      part[field] = parsed.data;
      return;
    }
  }
}

/**
 * Derive frozen mirror state. Confidence never auto-verifies; only human
 * provenance or an acceptance record yields verified.
 */
export function deriveHbomCellState(
  cell: HbomCell<unknown> | undefined,
): HbomCellState {
  if (cell === undefined) return "unknown";
  const keys = Object.keys(cell);
  if (keys.length === 1 && keys[0] === "value" && cell.value === null) {
    return "unknown";
  }
  if (cell.provenance === "human" && cell.value === null) {
    return "not_applicable";
  }
  if (cell.provenance === "human" || cell.accepted !== undefined) {
    return "verified";
  }
  if (cell.candidates !== undefined && cell.candidates.length > 0) {
    const incumbent = JSON.stringify(cell.value);
    for (const candidate of cell.candidates) {
      if (JSON.stringify(candidate.value) !== incumbent) {
        return "conflict";
      }
    }
  }
  if (cell.provenance === undefined && cell.value === null) {
    return "unknown";
  }
  return "proposal";
}

function readOptionalString(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`${path} must be a string when present`);
    return undefined;
  }
  return value;
}

function readNullableString(
  value: unknown,
  path: string,
  issues: string[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push(`${path} must be string or null`);
    return undefined;
  }
  return value;
}

export function parseHbomDocument(
  raw: unknown,
  options: { ledger?: DocumentLedgerLookup; file?: string } = {},
): HbomDocument {
  const file = options.file ?? "hbom.yaml";
  const issues: string[] = [];

  if (!isPlainRecord(raw)) {
    throw new HbomValidationError(
      "HBOM_INVALID",
      `${file}: root must be a mapping`,
      [`${file}: root must be a mapping`],
    );
  }

  assertNoUnknownKeys(raw, DOC_KEYS, file, issues);

  if (raw.schema !== HBOM_SCHEMA_ID) {
    issues.push(`${file}: schema must be "${HBOM_SCHEMA_ID}"`);
  }

  const project =
    typeof raw.project === "string" && raw.project.trim().length > 0
      ? raw.project.trim()
      : null;
  if (project === null) {
    issues.push(`${file}: project must be a non-empty string`);
  }

  const asProjectId = readOptionalString(
    raw.asProjectId,
    `${file}.asProjectId`,
    issues,
  );

  let reviewThreshold: number | null = null;
  let exportThreshold: number | null = null;
  if (!isPlainRecord(raw.options)) {
    issues.push(`${file}: options must be an object`);
  } else {
    assertNoUnknownKeys(raw.options, OPTIONS_KEYS, `${file}.options`, issues);
    if (
      typeof raw.options.reviewThreshold === "number" &&
      raw.options.reviewThreshold >= 0 &&
      raw.options.reviewThreshold <= 1
    ) {
      reviewThreshold = raw.options.reviewThreshold;
    } else {
      issues.push(`${file}.options.reviewThreshold must be a number in [0, 1]`);
    }
    if (
      typeof raw.options.exportThreshold === "number" &&
      raw.options.exportThreshold >= 0 &&
      raw.options.exportThreshold <= 1
    ) {
      exportThreshold = raw.options.exportThreshold;
    } else {
      issues.push(`${file}.options.exportThreshold must be a number in [0, 1]`);
    }
  }

  if (!Array.isArray(raw.parts)) {
    issues.push(`${file}: parts must be an array`);
  }

  if (
    issues.length > 0 ||
    project === null ||
    reviewThreshold === null ||
    exportThreshold === null ||
    !Array.isArray(raw.parts)
  ) {
    throw new HbomValidationError(
      "HBOM_INVALID",
      issues[0] ?? `${file}: document failed validation`,
      issues,
    );
  }

  const seenIds = new Set<string>();
  const parts: HbomPart[] = [];

  for (let index = 0; index < raw.parts.length; index += 1) {
    const partPath = `${file}.parts[${index}]`;
    const partRaw = raw.parts[index];
    if (!isPlainRecord(partRaw)) {
      issues.push(`${partPath}: part must be an object`);
      continue;
    }
    assertNoUnknownKeys(partRaw, PART_KEYS, partPath, issues);

    const idParsed = partIdSchema.safeParse(partRaw.id);
    let partId: string | null = null;
    if (!idParsed.success) {
      issues.push(
        `${partPath}.id: ${idParsed.error.issues[0]?.message ?? "invalid"}`,
      );
    } else if (seenIds.has(idParsed.data)) {
      issues.push(`${partPath}.id: duplicate part id "${idParsed.data}"`);
    } else {
      partId = idParsed.data;
      seenIds.add(idParsed.data);
    }

    const asComponentId = readNullableString(
      partRaw.asComponentId === undefined ? null : partRaw.asComponentId,
      `${partPath}.asComponentId`,
      issues,
    );
    const boardRevision = readNullableString(
      partRaw.boardRevision,
      `${partPath}.boardRevision`,
      issues,
    );

    let asMissing: boolean | undefined;
    if (partRaw.asMissing !== undefined) {
      if (typeof partRaw.asMissing === "boolean") {
        asMissing = partRaw.asMissing;
      } else {
        issues.push(`${partPath}.asMissing must be a boolean`);
      }
    }

    const externalRefs: Array<z.infer<typeof externalRefSchema>> = [];
    if (partRaw.externalRefs !== undefined) {
      if (!Array.isArray(partRaw.externalRefs)) {
        issues.push(`${partPath}.externalRefs must be an array`);
      } else {
        for (
          let refIndex = 0;
          refIndex < partRaw.externalRefs.length;
          refIndex += 1
        ) {
          const refParsed = externalRefSchema.safeParse(
            partRaw.externalRefs[refIndex],
          );
          if (!refParsed.success) {
            issues.push(
              `${partPath}.externalRefs[${refIndex}]: ${refParsed.error.issues[0]?.message ?? "invalid"}`,
            );
          } else {
            externalRefs.push(refParsed.data);
          }
        }
      }
    }

    if (partId === null) {
      continue;
    }

    const part: HbomPart = {
      id: partId,
      asComponentId: asComponentId ?? null,
    };
    if (boardRevision !== undefined) {
      part.boardRevision = boardRevision;
    }
    if (asMissing !== undefined) {
      part.asMissing = asMissing;
    }
    if (externalRefs.length > 0) {
      part.externalRefs = externalRefs;
    }

    for (const field of HBOM_PART_FIELDS) {
      parseAndAssignCell(
        part,
        field,
        partRaw[field],
        `${partPath}.${field}`,
        issues,
        options.ledger,
      );
    }

    parts.push(part);
  }

  if (issues.length > 0) {
    throw new HbomValidationError(
      "HBOM_INVALID",
      issues[0] ?? `${file}: document failed validation`,
      issues,
    );
  }

  const document: HbomDocument = {
    schema: HBOM_SCHEMA_ID,
    project,
    options: {
      reviewThreshold,
      exportThreshold,
    },
    parts,
  };
  if (asProjectId !== undefined) {
    document.asProjectId = asProjectId;
  }
  return document;
}

export function assertCellNotScalar(value: unknown, field: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value)
  ) {
    throw new HbomValidationError(
      "HBOM_SCALAR_CELL",
      `${field}: every HBOM field must be a provenance cell, not a scalar`,
      [`${field}: scalar shortcut rejected`],
    );
  }
}

export function isKnownDocumentDigest(digest: string): boolean {
  return sha256Schema.safeParse(digest).success;
}
