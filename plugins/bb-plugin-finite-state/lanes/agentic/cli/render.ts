import type { PluginCliResult } from "@bb/plugin-sdk";

import { CLI_JSON_MAX_BYTES } from "./metadata.js";
import type { CliExit } from "./parser.js";

export interface TruncationEnvelope {
  items: unknown[];
  total: number;
  cursor: string | null;
  truncated: true;
  next: string;
  maxBytes: number;
}

export function result(
  exitCode: CliExit | 1,
  stdout: string,
  stderr = "",
): PluginCliResult {
  return { exitCode, stdout, stderr };
}

export function encodeJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function encodePretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function jsonOutput(value: unknown, json: boolean): string {
  return json ? encodeJson(value) : encodePretty(value);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Cap JSON at 1 MiB without silent truncation. Oversized list pages become a
 * valid cursor/truncation envelope that remains under the host ceiling.
 */
export function capJsonList(
  items: readonly unknown[],
  total: number,
  cursor: string | null,
  extras: Record<string, unknown> = {},
): { payload: unknown; truncated: boolean } {
  const full = { items, total, cursor, ...extras };
  const encoded = JSON.stringify(full);
  if (utf8Bytes(`${encoded}\n`) <= CLI_JSON_MAX_BYTES) {
    return { payload: full, truncated: false };
  }
  let kept = items.length;
  while (kept > 0) {
    const slice = items.slice(0, kept);
    const envelope: TruncationEnvelope & Record<string, unknown> = {
      items: [...slice],
      total,
      cursor,
      truncated: true,
      next: cursor ?? `truncated:${kept}`,
      maxBytes: CLI_JSON_MAX_BYTES,
      ...extras,
    };
    if (utf8Bytes(`${JSON.stringify(envelope)}\n`) <= CLI_JSON_MAX_BYTES) {
      return { payload: envelope, truncated: true };
    }
    kept = Math.floor(kept / 2);
  }
  const empty: TruncationEnvelope = {
    items: [],
    total,
    cursor,
    truncated: true,
    next: cursor ?? "truncated:0",
    maxBytes: CLI_JSON_MAX_BYTES,
  };
  return { payload: empty, truncated: true };
}

export function renderTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  if (rows.length === 0) {
    return `${headers.join("\t")}\n(no rows)\n`;
  }
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0))
      .join("  ");
  return `${[line(headers), ...rows.map(line)].join("\n")}\n`;
}

export function reviewHandoff(input: {
  title: string;
  route: string;
  summary: string;
  json: boolean;
  extra?: Record<string, unknown>;
}): PluginCliResult {
  const payload = {
    handedOff: true,
    executed: false,
    route: input.route,
    summary: input.summary,
    ...input.extra,
  };
  if (input.json) {
    return result(3, encodeJson(payload));
  }
  const stdout = [
    input.title,
    `Review panel: ${input.route}`,
    input.summary,
    "This CLI command did not mutate upstream state.",
    "",
  ].join("\n");
  return result(3, stdout);
}

export function failUsage(message: string): PluginCliResult {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

export function failConfig(message: string): PluginCliResult {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

export function failConflict(message: string): PluginCliResult {
  return { exitCode: 3, stdout: "", stderr: `${message}\n` };
}

export function failTransport(message: string): PluginCliResult {
  return { exitCode: 5, stdout: "", stderr: `${message}\n` };
}

export function failPartial(stdout: string, stderr = ""): PluginCliResult {
  return { exitCode: 4, stdout, stderr };
}

export function flagString(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): boolean {
  return flags[name] === true;
}
