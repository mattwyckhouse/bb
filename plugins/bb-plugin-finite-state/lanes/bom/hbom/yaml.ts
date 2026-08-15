import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  emitYaml,
  parseYaml,
  SerializeError,
} from "../../sync/serialize/yaml.js";
import {
  parseHbomDocument,
  type DocumentLedgerLookup,
  HbomValidationError,
} from "./schema.js";
import {
  HBOM_RELATIVE_PATH,
  type HbomDocument,
  type HbomReadResult,
} from "./types.js";

export class HbomStaleError extends Error {
  readonly code = "HBOM_STALE" as const;

  constructor(
    readonly expectedSha256: string,
    readonly currentSha256: string,
  ) {
    super(
      "HBOM YAML changed concurrently. Reload the file and retry with the current SHA-256.",
    );
    this.name = "HbomStaleError";
  }
}

export class HbomMissingError extends Error {
  readonly code = "HBOM_MISSING" as const;

  constructor(readonly path: string) {
    super(`HBOM YAML is missing at ${path}`);
    this.name = "HbomMissingError";
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function hbomAbsolutePath(root: string): string {
  if (!isAbsolute(root)) {
    throw new HbomValidationError(
      "HBOM_ROOT_INVALID",
      "HBOM root must be an absolute path",
      ["root must be absolute"],
    );
  }
  return resolve(root, ...HBOM_RELATIVE_PATH.split("/"));
}

export function emptyHbomDocument(project: string): HbomDocument {
  return {
    schema: "fs-hbom/v1",
    project,
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [],
  };
}

/** SHA-256 of the empty string — used as the expected digest when creating the file. */
export const HBOM_EMPTY_SHA256 = sha256("");

function documentToYamlRecord(document: HbomDocument): Record<string, unknown> {
  const record: Record<string, unknown> = {
    schema: document.schema,
    project: document.project,
    options: {
      reviewThreshold: document.options.reviewThreshold,
      exportThreshold: document.options.exportThreshold,
    },
    parts: document.parts,
  };
  if (document.asProjectId !== undefined) {
    record.asProjectId = document.asProjectId;
  }
  return record;
}

export function serializeHbom(document: HbomDocument): string {
  return emitYaml(documentToYamlRecord(document));
}

export function parseHbomText(
  text: string,
  file: string,
  ledger?: DocumentLedgerLookup,
): HbomDocument {
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(text, file);
  } catch (error) {
    if (error instanceof SerializeError) {
      throw new HbomValidationError("HBOM_INVALID", error.message, [
        `${file}: ${error.message}`,
      ]);
    }
    throw error;
  }
  return parseHbomDocument(raw, { file, ledger });
}

export async function readHbom(
  root: string,
  options: { ledger?: DocumentLedgerLookup } = {},
): Promise<HbomReadResult> {
  const path = hbomAbsolutePath(root);
  let text: string;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new HbomValidationError(
        "HBOM_INVALID",
        `${HBOM_RELATIVE_PATH} must be a regular file`,
        [`${HBOM_RELATIVE_PATH}: not a regular file`],
      );
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) {
      throw new HbomMissingError(HBOM_RELATIVE_PATH);
    }
    throw error;
  }
  const document = parseHbomText(text, HBOM_RELATIVE_PATH, options.ledger);
  return { document, sha256: sha256(text), text };
}

async function ensureHbomDirectory(root: string): Promise<void> {
  const directory = dirname(hbomAbsolutePath(root));
  const fromRoot = relative(root, directory);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new HbomValidationError(
      "HBOM_PATH_ESCAPE",
      "HBOM path escapes the project root",
      ["path escape"],
    );
  }
  let current = root;
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new HbomValidationError(
          "HBOM_PATH_INVALID",
          "HBOM directory path contains a symlink or non-directory",
          [relative(root, current)],
        );
      }
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

/**
 * Compare-and-swap write. Callers supply the SHA-256 they read; a mismatch
 * returns HBOM_STALE without changing the file. No last-writer-wins fallback.
 */
export async function writeHbomCas(
  root: string,
  expectedSha256: string,
  next: HbomDocument,
  options: { ledger?: DocumentLedgerLookup } = {},
): Promise<string> {
  // Validate before touching disk.
  parseHbomDocument(documentToYamlRecord(next), {
    file: HBOM_RELATIVE_PATH,
    ledger: options.ledger,
  });
  const text = serializeHbom(next);
  // Round-trip through the same serializer path so the digest matches a future read.
  const reparsed = parseHbomText(text, HBOM_RELATIVE_PATH, options.ledger);
  const canonical = serializeHbom(reparsed);
  const nextSha = sha256(canonical);

  await ensureHbomDirectory(root);
  const path = hbomAbsolutePath(root);
  let currentSha = HBOM_EMPTY_SHA256;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new HbomValidationError(
        "HBOM_INVALID",
        `${HBOM_RELATIVE_PATH} must be a regular file`,
        [`${HBOM_RELATIVE_PATH}: not a regular file`],
      );
    }
    const existing = await readFile(path, "utf8");
    currentSha = sha256(existing);
  } catch (error) {
    if (!missing(error)) throw error;
  }

  if (currentSha !== expectedSha256) {
    throw new HbomStaleError(expectedSha256, currentSha);
  }

  const temp = join(
    dirname(path),
    `.hbom-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temp, canonical, { encoding: "utf8", mode: 0o644 });
    // Re-check immediately before rename to shrink the race window.
    let verifySha = HBOM_EMPTY_SHA256;
    try {
      const existing = await readFile(path, "utf8");
      verifySha = sha256(existing);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (verifySha !== expectedSha256) {
      throw new HbomStaleError(expectedSha256, verifySha);
    }
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }

  return nextSha;
}
