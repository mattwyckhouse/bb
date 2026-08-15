import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, open, realpath, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type { PluginCliContext, PluginCliResult } from "@bb/plugin-sdk";

import { CDX_HBOM_UNVERIFIED, createCycloneDxHbom } from "./cyclonedx.js";
import {
  createHbomWorkbook,
  HbomExportError,
  type ExportArtifact,
  type ExportDeps,
  type HbomExportMode,
} from "./xlsx.js";

export interface HbomExportCliDeps extends ExportDeps {
  /** Verified host boundary supplied by WP-64's command-tree composition. */
  permittedOutputRoot: string;
  createId?: () => string;
}

interface CliOptions {
  mode: HbomExportMode;
  format: "xlsx" | "cdx";
  output: string | null;
  json: boolean;
}

class HbomExportCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HbomExportCliError";
    this.code = code;
  }
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new HbomExportCliError(
      "HBOM_CLI_USAGE",
      `${option} requires a value.`,
    );
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  let format: "xlsx" | "cdx" | null = null;
  let mode: HbomExportMode = "full";
  let output: string | null = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--xlsx") {
      if (format !== null) {
        throw new HbomExportCliError(
          "HBOM_CLI_USAGE",
          "Choose exactly one of --xlsx or --cdx.",
        );
      }
      format = "xlsx";
    } else if (arg === "--cdx") {
      if (format !== null) {
        throw new HbomExportCliError(
          "HBOM_CLI_USAGE",
          "Choose exactly one of --xlsx or --cdx.",
        );
      }
      format = "cdx";
    } else if (arg === "--verified-only") {
      mode = "verified-only";
    } else if (arg === "-o" || arg === "--output") {
      if (output !== null) {
        throw new HbomExportCliError(
          "HBOM_CLI_USAGE",
          "An output path may be provided only once.",
        );
      }
      output = optionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new HbomExportCliError("HBOM_CLI_USAGE", `Unknown option: ${arg}`);
    }
  }

  if (format === null) {
    throw new HbomExportCliError("HBOM_CLI_USAGE", "Specify --xlsx or --cdx.");
  }
  if (output === null && !json) {
    throw new HbomExportCliError(
      "HBOM_OUTPUT_REQUIRED",
      "Binary HBOM output is not written to the terminal. Provide -o <file>, or use --json for metadata only.",
    );
  }
  return { mode, format, output, json };
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function resolveOutputPath(
  rootInput: string,
  cwd: string | undefined,
  output: string,
): Promise<string> {
  const root = await realpath(rootInput);
  const base = cwd === undefined ? root : await realpath(cwd);
  const unresolved = resolve(base, output);
  const parent = await realpath(dirname(unresolved)).catch(() => {
    throw new HbomExportCliError(
      "HBOM_OUTPUT_PARENT_INVALID",
      "The output directory must already exist inside the permitted output boundary.",
    );
  });
  const candidate = resolve(parent, basename(unresolved));
  if (candidate === root || !isWithin(root, candidate)) {
    throw new HbomExportCliError(
      "HBOM_OUTPUT_OUTSIDE_BOUNDARY",
      "The output file must be inside the permitted output boundary.",
    );
  }
  await access(parent, constants.W_OK).catch(() => {
    throw new HbomExportCliError(
      "HBOM_OUTPUT_NOT_WRITABLE",
      "The output directory is not writable.",
    );
  });
  try {
    await lstat(candidate);
    throw new HbomExportCliError(
      "HBOM_OUTPUT_EXISTS",
      "The output file already exists; choose a new path.",
    );
  } catch (error: unknown) {
    if (error instanceof HbomExportCliError) throw error;
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  return candidate;
}

async function writeChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset);
    if (result.bytesWritten === 0) {
      throw new HbomExportCliError(
        "HBOM_OUTPUT_WRITE_FAILED",
        "The output file could not be written.",
      );
    }
    offset += result.bytesWritten;
  }
}

async function writeAtomically(
  artifact: ExportArtifact,
  destination: string,
  createId: () => string,
): Promise<void> {
  const partial = resolve(
    dirname(destination),
    `.${basename(destination)}.bb-fs-${createId()}.part`,
  );
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(partial, "wx", 0o600);
    for await (const chunk of artifact.stream) {
      if (!(chunk instanceof Uint8Array)) {
        throw new HbomExportCliError(
          "HBOM_EXPORT_INVALID_CHUNK",
          "The HBOM export stream was invalid.",
        );
      }
      await writeChunk(file, chunk);
    }
    await file.sync();
    await file.close();
    file = null;
    await link(partial, destination).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new HbomExportCliError(
          "HBOM_OUTPUT_EXISTS",
          "The output file already exists; choose a new path.",
        );
      }
      throw error;
    });
    await unlink(partial);
  } catch (error: unknown) {
    await file?.close().catch(() => undefined);
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

function safeCliError(error: unknown): PluginCliResult {
  if (error instanceof HbomExportCliError || error instanceof HbomExportError) {
    return { exitCode: 2, stderr: `${error.code}: ${error.message}\n` };
  }
  return {
    exitCode: 1,
    stderr:
      "HBOM_EXPORT_FAILED: The HBOM export failed; no partial output was kept.\n",
  };
}

/**
 * HBOM export command handler for WP-64. Does not call bb.cli.register.
 */
export async function handleHbomExportCli(
  deps: HbomExportCliDeps,
  argv: string[],
  context: PluginCliContext = {},
): Promise<PluginCliResult> {
  let artifact: ExportArtifact | null = null;
  try {
    const options = parseArgs(argv);
    const destination =
      options.output === null
        ? null
        : await resolveOutputPath(
            deps.permittedOutputRoot,
            context.cwd,
            options.output,
          );
    artifact =
      options.format === "xlsx"
        ? await createHbomWorkbook(deps, options.mode)
        : await createCycloneDxHbom(deps, options.mode);
    if (destination !== null) {
      await writeAtomically(artifact, destination, deps.createId ?? randomUUID);
    }
    const metadata = {
      filename: artifact.filename,
      contentType: artifact.contentType,
      bytes: artifact.bytes,
      format: options.format,
      mode: options.mode,
      written: destination !== null,
      ...(options.format === "cdx" ? { note: CDX_HBOM_UNVERIFIED } : {}),
    };
    return options.json
      ? { exitCode: 0, stdout: `${JSON.stringify(metadata)}\n` }
      : { exitCode: 0, stdout: `Exported ${metadata.filename}.\n` };
  } catch (error: unknown) {
    return safeCliError(error);
  } finally {
    await artifact?.dispose().catch(() => undefined);
  }
}
