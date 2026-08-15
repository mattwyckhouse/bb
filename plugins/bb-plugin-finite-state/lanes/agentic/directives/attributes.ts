import { z } from "zod";
import {
  findingStableKey,
  InvalidEntityKeyError,
} from "../../../lib/sync/registry.js";
import type { DirectiveId } from "../../../lib/agentic/types.js";
import { findingDetailSubPath } from "../../findings/ui/route.js";
import {
  componentSubPath,
  encodeComponentRouteKey,
  BomRouteError,
} from "../../bom/app/sbom/routes.js";

/**
 * Attribute schemas for every canonical directive id (SPEC 06 / WP-61).
 *
 * PR 1 shipped the six card-backed ids; PR 2 wires the FS-229 owner cards and
 * canvas/matrix directive modes. Schemas stay complete for CLI/SDK consumers.
 *
 * `fs-hbom-summary` keeps an empty attribute object by contract. The wrapper
 * takes `projectId` from `PluginMessageDirectiveProps.message.projectId`
 * (coordinator ruling 2026-08-15 on FS-75).
 */

export const MAX_BOUNDED_ID_LENGTH = 512;
export const MAX_BOUNDED_SLUG_LENGTH = 128;
export const MAX_BOUNDED_FILTER_LENGTH = 256;

const CONTROL = /[\u0000-\u001f\u007f]/u;
const PATH_SEP = /[\\/]/u;

const boundedId = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BOUNDED_ID_LENGTH)
  .refine((value) => !CONTROL.test(value), {
    message: "id must not contain control characters",
  });

const boundedSlug = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BOUNDED_SLUG_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, {
    message: "slug must be a bounded route-safe identifier",
  });

const boundedFilter = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BOUNDED_FILTER_LENGTH)
  .refine((value) => !CONTROL.test(value), {
    message: "filter must not contain control characters",
  });

export const directiveSchemas = {
  "fs-plan": z.strictObject({ id: boundedId }),
  "fs-finding": z
    .strictObject({ id: boundedId })
    .or(z.strictObject({ cve: boundedId, purl: boundedId })),
  "fs-triage-summary": z.strictObject({
    id: boundedId,
    version: boundedId.optional(),
  }),
  "fs-threat": z.strictObject({ id: boundedSlug }),
  "fs-canvas": z.strictObject({
    focus: boundedSlug.optional(),
    highlight: boundedSlug.optional(),
    height: z.coerce.number().min(280).max(560).default(420),
  }),
  "fs-req": z.strictObject({ id: boundedSlug }),
  "fs-matrix": z.strictObject({ filter: boundedFilter.optional() }),
  "fs-component": z.union([
    z.strictObject({ purl: boundedId }),
    z.strictObject({ part: boundedSlug }),
  ]),
  "fs-hbom-summary": z.strictObject({}),
  "fs-bench": z.strictObject({ id: boundedId }),
  "fs-verdict": z.strictObject({ id: boundedId }),
  "fs-doc": z.strictObject({ id: boundedId }),
} as const;

export type DirectiveSchemaMap = typeof directiveSchemas;
export type ParsedDirectiveAttributes<Id extends DirectiveId> = z.output<
  DirectiveSchemaMap[Id]
>;

/** Six card-backed directives shipped in WP-61 PR 1. */
export const PR1_DIRECTIVE_IDS = [
  "fs-finding",
  "fs-req",
  "fs-component",
  "fs-hbom-summary",
  "fs-bench",
  "fs-verdict",
] as const satisfies readonly DirectiveId[];

export type Pr1DirectiveId = (typeof PR1_DIRECTIVE_IDS)[number];

/** FS-229 owner cards / canvas+matrix modes — WP-61 PR 2. */
export const PR2_DIRECTIVE_IDS = [
  "fs-plan",
  "fs-triage-summary",
  "fs-threat",
  "fs-canvas",
  "fs-matrix",
  "fs-doc",
] as const satisfies readonly DirectiveId[];

export type Pr2DirectiveId = (typeof PR2_DIRECTIVE_IDS)[number];

/** All twelve registered directive ids (PR1 ∪ PR2). */
export const REGISTERED_DIRECTIVE_IDS = [
  ...PR1_DIRECTIVE_IDS,
  ...PR2_DIRECTIVE_IDS,
] as const satisfies readonly DirectiveId[];

export type AttributeParseResult<Id extends DirectiveId> =
  | { ok: true; value: ParsedDirectiveAttributes<Id> }
  | { ok: false; issues: string[] };

export function isDirectiveId(value: string): value is DirectiveId {
  return Object.hasOwn(directiveSchemas, value);
}

export function parseDirectiveAttributes<Id extends DirectiveId>(
  id: Id,
  attributes: Readonly<Record<string, string>>,
): AttributeParseResult<Id> {
  const schema = directiveSchemas[id];
  const parsed = schema.safeParse(attributes);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "attributes"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, value: parsed.data as ParsedDirectiveAttributes<Id> };
}

/**
 * Opaque finding identity for routes and FindingCard. Never interpolate raw
 * `cve`/`purl` into a URL or filesystem path — always go through the frozen
 * finding-key codec first.
 *
 * For the `{cve,purl}` attribute form the frozen codec still requires a
 * `name` field even though purl-tier segments omit it; a non-encoded
 * placeholder satisfies the boundary without leaking into the key.
 */
export function encodeFindingDirectiveKey(
  attrs: { id: string } | { cve: string; purl: string },
): string {
  if ("id" in attrs) return attrs.id;
  return findingStableKey(
    {
      cve: attrs.cve,
      purl: attrs.purl,
      name: "component",
    },
    "purl",
  );
}

/** Findings panel subPath using the shared route helper (opaque key only). */
export function findingDirectiveSubPath(stableKey: string): string {
  return findingDetailSubPath(stableKey, {});
}

export function componentDirectiveSubPath(
  attrs: { purl: string } | { part: string },
): string {
  if ("purl" in attrs) return componentSubPath(attrs.purl);
  return `hardware/${encodeURIComponent(attrs.part)}`;
}

export function requirementDirectiveSubPath(requirementId: string): string {
  return `requirements/trace/${encodeURIComponent(requirementId)}`;
}

export function benchRunDirectiveSubPath(runId: string): string {
  return encodeURIComponent(runId);
}

export function verdictDirectiveSubPath(pvId: string): string {
  return `verdict/${encodeURIComponent(pvId)}`;
}

export function planDirectiveSubPath(planId: string): string {
  return `plan/${encodeURIComponent(planId)}`;
}

export function triageSummaryDirectiveSubPath(): string {
  return "triage";
}

export function threatDirectiveSubPath(slug: string): string {
  return `tara/threats/${encodeURIComponent(slug)}`;
}

export function docDirectiveSubPath(documentId: string): string {
  return encodeURIComponent(documentId);
}

export function canvasDirectiveSubPath(attrs: {
  focus?: string;
  highlight?: string;
}): string {
  if (attrs.highlight) {
    return `tara/threats/${encodeURIComponent(attrs.highlight)}`;
  }
  if (attrs.focus) {
    return `tara/nodes/${encodeURIComponent(attrs.focus)}`;
  }
  return "tara";
}

export function matrixDirectiveSubPath(): string {
  return "verifications";
}

/** WP-61 in-message matrix slice cap. */
export const MATRIX_DIRECTIVE_MAX_ROWS = 15 as const;

/**
 * Workspace-relative paths only: no absolute roots, no `.` / `..` segments.
 * Callers must use this before `openWorkspaceFile`.
 */
export function validateWorkspaceRelativePath(path: string): string | null {
  const normalized = path.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_BOUNDED_ID_LENGTH ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    /^[A-Za-z]:/u.test(normalized) ||
    CONTROL.test(normalized)
  ) {
    return null;
  }
  const segments = normalized.replaceAll("\\", "/").split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return normalized.replaceAll("\\", "/");
}

/**
 * Attack helper for tests: a raw `project|purl|CVE` style identity must not be
 * accepted as a route segment without the shared encoder.
 */
export function assertFindingRouteUsesEncoder(rawIdentity: string): string {
  if (PATH_SEP.test(rawIdentity) || rawIdentity.includes("|")) {
    try {
      encodeComponentRouteKey(rawIdentity);
    } catch (error) {
      if (!(error instanceof BomRouteError)) throw error;
    }
    throw new InvalidEntityKeyError(
      "raw stable key cannot escape route encoder",
    );
  }
  return encodeFindingDirectiveKey({ id: rawIdentity });
}

export function openValidatedWorkspaceFile(
  openWorkspaceFile: ((path: string) => boolean) | null,
  path: string,
): boolean {
  if (!openWorkspaceFile) return false;
  const validated = validateWorkspaceRelativePath(path);
  if (validated === null) return false;
  return openWorkspaceFile(validated);
}
