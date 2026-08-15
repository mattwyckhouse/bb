import {
  documentSourceRefSchema,
  sha256Schema,
  type DocumentLocator,
  type DocumentSourceRef,
} from "../../shared/contract.js";

const SHA_PREFIX = /^docs\/([a-f0-9]{64})#(.*)$/u;
const PDF_FRAGMENT =
  /^p([1-9][0-9]*)(?:@([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+))?$/u;
const TEXT_FRAGMENT = /^L([1-9][0-9]*)-([1-9][0-9]*)$/u;
const SHEET_FRAGMENT = /^(?:'((?:[^']|'')+)'|([^'!]+))!([A-Z]+[1-9][0-9]*)$/u;

export class DocumentSourceRefError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentSourceRefError";
  }
}

function quoteSheet(sheet: string): string {
  if (/^[A-Za-z0-9_. -]+$/u.test(sheet) && !sheet.includes("'")) {
    return sheet;
  }
  return `'${sheet.replaceAll("'", "''")}'`;
}

function unquoteSheet(raw: string): string {
  return raw.replaceAll("''", "'");
}

function encodeLocator(locator: DocumentLocator): string {
  if (locator.kind === "pdf") {
    const page = `p${locator.page}`;
    if (locator.bbox === undefined) return page;
    const [x0, y0, x1, y1] = locator.bbox;
    return `${page}@${x0},${y0},${x1},${y1}`;
  }
  if (locator.kind === "sheet") {
    return `${quoteSheet(locator.sheet)}!${locator.cell}`;
  }
  return `L${locator.lineStart}-${locator.lineEnd}`;
}

function decodeLocator(fragment: string): DocumentLocator {
  const pdf = PDF_FRAGMENT.exec(fragment);
  if (pdf) {
    const page = Number(pdf[1]);
    if (pdf[2] === undefined) {
      return { kind: "pdf", page };
    }
    const bbox: [number, number, number, number] = [
      Number(pdf[2]),
      Number(pdf[3]),
      Number(pdf[4]),
      Number(pdf[5]),
    ];
    if (
      bbox.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      throw new DocumentSourceRefError(
        "DOCUMENT_SOURCE_REF_INVALID",
        "PDF bbox coordinates must be normalized to [0, 1].",
      );
    }
    if (bbox[2] < bbox[0] || bbox[3] < bbox[1]) {
      throw new DocumentSourceRefError(
        "DOCUMENT_SOURCE_REF_INVALID",
        "PDF bbox must not be inverted.",
      );
    }
    return { kind: "pdf", page, bbox };
  }

  const text = TEXT_FRAGMENT.exec(fragment);
  if (text) {
    const lineStart = Number(text[1]);
    const lineEnd = Number(text[2]);
    if (lineEnd < lineStart) {
      throw new DocumentSourceRefError(
        "DOCUMENT_SOURCE_REF_INVALID",
        "Text lineEnd must be greater than or equal to lineStart.",
      );
    }
    return { kind: "text", lineStart, lineEnd };
  }

  const sheet = SHEET_FRAGMENT.exec(fragment);
  if (sheet) {
    const name = sheet[1] !== undefined ? unquoteSheet(sheet[1]) : sheet[2]!;
    if (name.length < 1 || name.length > 200) {
      throw new DocumentSourceRefError(
        "DOCUMENT_SOURCE_REF_INVALID",
        "Sheet name length is out of bounds.",
      );
    }
    return { kind: "sheet", sheet: name, cell: sheet[3]! };
  }

  throw new DocumentSourceRefError(
    "DOCUMENT_SOURCE_REF_INVALID",
    "Unrecognized document source-ref fragment.",
  );
}

export function encodeSourceRef(ref: DocumentSourceRef): string {
  const parsed = documentSourceRefSchema.safeParse(ref);
  if (!parsed.success) {
    throw new DocumentSourceRefError(
      "DOCUMENT_SOURCE_REF_INVALID",
      "Document source ref failed schema validation.",
    );
  }
  return `docs/${parsed.data.documentSha256}#${encodeLocator(parsed.data.locator)}`;
}

export function decodeSourceRef(value: string): DocumentSourceRef {
  if (value.length < 1 || value.length > 4096) {
    throw new DocumentSourceRefError(
      "DOCUMENT_SOURCE_REF_INVALID",
      "Document source ref string length is out of bounds.",
    );
  }
  const match = SHA_PREFIX.exec(value);
  if (!match) {
    throw new DocumentSourceRefError(
      "DOCUMENT_SOURCE_REF_INVALID",
      "Document source ref must be docs/<sha256>#<locator>.",
    );
  }
  const documentSha256 = sha256Schema.parse(match[1]);
  const locator = decodeLocator(match[2]!);
  const parsed = documentSourceRefSchema.safeParse({ documentSha256, locator });
  if (!parsed.success) {
    throw new DocumentSourceRefError(
      "DOCUMENT_SOURCE_REF_INVALID",
      "Decoded document source ref failed schema validation.",
    );
  }
  return parsed.data;
}
