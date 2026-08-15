import type Database from "better-sqlite3";

import { SOFT_RESPONSE_BYTES } from "../../../lib/agentic/budget.js";
import { queryFindings } from "../../findings/cache/query.js";
import { querySbomForProject } from "../../bom/sbom/query.js";
import { getDocumentBySha } from "../../documents/store.js";
import { listDocumentExtractions } from "../../documents/search.js";
import { getBenchRun, listBenchRuns } from "../../bench/store/runs.js";
import { getOtaVerdict } from "../../bench/verdict/query.js";
import {
  resolveMentionScopes,
  type MentionProviderId,
  type MentionScope,
} from "./search.js";

export interface MentionResolveHooks {
  resolvers?: Partial<
    Record<
      MentionProviderId,
      (
        db: Database.Database,
        scopes: MentionScope[],
        itemId: string,
      ) => Promise<string> | string
    >
  >;
  contextBudgetBytes?: number;
}

function clampContext(text: string, budget: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budget) return text;
  const truncated = text.slice(0, Math.max(0, budget - 80));
  return `${truncated}\n…[truncated to ${budget} bytes]`;
}

function missingContext(
  provider: MentionProviderId,
  itemId: string,
  hint: string,
): string {
  return [
    `# Mention unavailable (${provider})`,
    "",
    `- Id: ${itemId}`,
    `- Status: no longer present in local cache/YAML indexes`,
    `- Recovery: ${hint}`,
    "",
    "Do not treat prior mention text as current. Re-query before acting.",
  ].join("\n");
}

function freshnessLine(
  asOf: string | null | undefined,
  state?: string,
): string {
  const parts = [
    state ? `cache=${state}` : null,
    asOf ? `asOf=${asOf}` : "asOf=unknown",
  ].filter((part): part is string => part !== null);
  return `- Freshness: ${parts.join(" · ")}`;
}

function modelKind(itemId: string): string {
  if (itemId.startsWith("REQ-")) return "requirement";
  if (itemId.startsWith("THREAT-")) return "threat";
  if (itemId.startsWith("COMP-")) return "component";
  if (itemId.startsWith("FLOW-")) return "dataflow";
  if (itemId.startsWith("CHK-") || itemId.startsWith("CHECK-")) return "check";
  return "entity";
}

function resolveModel(
  db: Database.Database,
  scopes: MentionScope[],
  itemId: string,
): string {
  const kind = modelKind(itemId);
  if (kind === "check") {
    for (const scope of scopes) {
      if (scope.projectVersionId === null) continue;
      const row = db
        .prepare<
          [string, string, string],
          {
            code: string;
            name: string;
            check_type: string;
            pulled_at: string;
          }
        >(
          `SELECT c.code, c.name, c.check_type, c.pulled_at
             FROM verification_checks c
            WHERE c.project_id = ?
              AND c.project_version_id = ?
              AND c.code = ?
              AND c.deleted_at IS NULL
              AND c.generation_id IN (
                SELECT accepted_generation_id FROM sync_state
                 WHERE project_id = c.project_id
                   AND project_version_id = c.project_version_id
                   AND accepted_generation_id IS NOT NULL
              )
            ORDER BY c.pulled_at DESC
            LIMIT 1`,
        )
        .get(scope.projectId, scope.projectVersionId, itemId);
      if (!row) continue;
      return [
        `# ${row.code}`,
        "",
        `- Kind: check`,
        `- Name: ${row.name}`,
        `- Type: ${row.check_type}`,
        freshnessLine(row.pulled_at, "fresh"),
        `- Directive: ::fs-req{id="(mapped requirement)"}`,
        `- Query: bb finite-state verify results <REQ-id>`,
      ].join("\n");
    }
    return missingContext(
      "fs-model",
      itemId,
      `bb finite-state verify matrix --json and search for ${itemId}`,
    );
  }

  const entityKind =
    kind === "requirement"
      ? "requirement"
      : kind === "threat"
        ? "threat"
        : kind === "component"
          ? "component"
          : kind === "dataflow"
            ? "dataflow"
            : null;
  if (entityKind === null) {
    return missingContext(
      "fs-model",
      itemId,
      "bb finite-state tara show <slug> or bb finite-state req show <REQ-id>",
    );
  }

  for (const scope of scopes) {
    if (scope.projectVersionId === null) continue;
    const row = db
      .prepare<
        [string, string, string, string],
        {
          entity_key: string;
          payload: string;
          pulled_at: string;
          last_pull: string | null;
        }
      >(
        `SELECT b.entity_key, b.payload, b.pulled_at, s.last_pull
           FROM base_snapshot b
           JOIN sync_state s
             ON s.project_id = b.project_id
            AND s.project_version_id = b.project_version_id
            AND s.entity_kind = b.entity_kind
            AND s.accepted_generation_id = b.generation_id
          WHERE b.project_id = ?
            AND b.project_version_id = ?
            AND b.entity_kind = ?
            AND b.entity_key = ?
          LIMIT 1`,
      )
      .get(scope.projectId, scope.projectVersionId, entityKind, itemId);
    if (!row) continue;

    let status = "unknown";
    let summary = "";
    try {
      const payload: unknown = JSON.parse(row.payload);
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload)
      ) {
        const statusValue = Reflect.get(payload, "status");
        const name = Reflect.get(payload, "name");
        const ears = Reflect.get(payload, "ears");
        if (typeof statusValue === "string") status = statusValue;
        if (typeof name === "string") summary = name;
        if (typeof ears === "object" && ears !== null && !Array.isArray(ears)) {
          const text = Reflect.get(ears, "text");
          if (typeof text === "string") summary = text.slice(0, 400);
        }
      }
    } catch {
      // Ignore malformed payloads; identity still resolves.
    }

    const directive =
      entityKind === "requirement"
        ? `::fs-req{id="${itemId}"}`
        : entityKind === "threat"
          ? `::fs-threat{id="${itemId}"}`
          : entityKind === "component"
            ? `::fs-canvas{focus="${itemId}"}`
            : `::fs-canvas{focus="${itemId}"}`;

    return [
      `# ${row.entity_key}`,
      "",
      `- Kind: ${entityKind}`,
      `- Status: ${status}`,
      ...(summary.length > 0 ? [`- Summary: ${summary}`] : []),
      freshnessLine(row.last_pull ?? row.pulled_at, "accepted-cache"),
      `- Directive: ${directive}`,
      entityKind === "requirement"
        ? `- Query: bb finite-state req show ${itemId}`
        : `- Query: bb finite-state tara show ${itemId}`,
    ].join("\n");
  }

  return missingContext(
    "fs-model",
    itemId,
    entityKind === "requirement"
      ? `bb finite-state req show ${itemId}`
      : `bb finite-state tara show ${itemId}`,
  );
}

function resolveDocs(
  db: Database.Database,
  scopes: MentionScope[],
  itemId: string,
): string {
  const sha = itemId.startsWith("doc:") ? itemId.slice(4) : itemId;
  for (const scope of scopes) {
    const record = getDocumentBySha(db, scope, sha);
    if (!record) continue;
    let extractionSummary = "none indexed";
    try {
      const extractions = listDocumentExtractions(db, scope, {
        documentId: record.documentId,
        pageSize: 5,
        continuation: null,
      });
      if (extractions.items.length > 0) {
        extractionSummary = extractions.items
          .map((hit) => {
            const field = hit.fields.field;
            const value = hit.fields.value;
            const fieldText = typeof field === "string" ? field : hit.label;
            const valueText =
              typeof value === "string" ? value.slice(0, 80) : "";
            return `${fieldText}=${valueText}`;
          })
          .join("; ");
      }
    } catch {
      extractionSummary = "unavailable";
    }
    return [
      `# ${record.name}`,
      "",
      `- Document SHA-256: ${record.sha256}`,
      `- Kind: ${record.kind}`,
      `- Bytes: ${record.bytes}`,
      `- MIME: ${record.mimeType}`,
      freshnessLine(record.uploadedAt, "ledger"),
      `- Extractions: ${extractionSummary}`,
      `- Directive: ::fs-doc{id="${record.sha256}"}`,
      `- Query: bb finite-state doc show ${record.sha256}`,
    ].join("\n");
  }
  return missingContext(
    "fs-docs",
    itemId,
    "bb finite-state doc list --json and search by name/sha",
  );
}

function resolveIntel(
  db: Database.Database,
  scopes: MentionScope[],
  itemId: string,
): string {
  if (itemId.startsWith("cve:")) {
    const cve = itemId.slice(4);
    for (const scope of scopes) {
      if (scope.projectVersionId === null) continue;
      const page = queryFindings(db, {
        projectId: scope.projectId,
        pvId: scope.projectVersionId,
        cve,
        limit: 5,
      });
      const finding = page.items[0];
      if (!finding) continue;
      return [
        `# ${finding.cve ?? finding.stableKey}`,
        "",
        `- Stable key: ${finding.stableKey}`,
        `- Component: ${finding.componentName ?? "unknown"} (${finding.componentPurl ?? "no purl"})`,
        `- Severity: ${finding.severity ?? "unknown"}`,
        `- Reachability: ${finding.reachabilityVerdict ?? "unknown"}`,
        `- Server VEX: ${finding.vexStatus ?? "none"}`,
        `- Local overlay: ${finding.localState}`,
        freshnessLine(page.cache.asOf, page.cache.state),
        `- Directive: ::fs-finding{id="${finding.stableKey}"}`,
        `- Query: bb finite-state triage list --filter cve:${cve}`,
      ].join("\n");
    }
    return missingContext(
      "fs-intel",
      itemId,
      `bb finite-state triage list --filter cve:${cve}`,
    );
  }

  if (itemId.startsWith("sbom:")) {
    const key = itemId.slice(5);
    for (const scope of scopes) {
      if (scope.projectVersionId === null) continue;
      const page = querySbomForProject(db, scope.projectId, {
        projectVersionId: scope.projectVersionId,
        componentKey: key,
        search: key.includes("/") ? undefined : key,
        limit: 5,
      });
      const component =
        page.items.find((item) => item.componentKey === key) ?? page.items[0];
      if (!component) continue;
      const vuln = component.vuln;
      return [
        `# ${component.name}`,
        "",
        `- Component key: ${component.componentKey}`,
        `- PURL: ${component.purl ?? "none"}`,
        `- Version: ${component.version ?? "unknown"}`,
        `- Vuln rollup: crit=${vuln.critical} high=${vuln.high} med=${vuln.medium} low=${vuln.low} kev=${vuln.kev}`,
        `- Reachability: ${vuln.reachability}`,
        freshnessLine(page.cache.asOf, page.cache.state),
        `- Directive: ::fs-component{purl="${component.purl ?? component.componentKey}"}`,
        `- Query: bb finite-state bom sbom list --filter ${component.name}`,
      ].join("\n");
    }
    return missingContext(
      "fs-intel",
      itemId,
      "bb finite-state bom sbom list --json",
    );
  }

  if (itemId.startsWith("hbom:")) {
    const partKey = itemId.slice(5);
    for (const scope of scopes) {
      if (scope.projectVersionId === null) continue;
      const rows = db
        .prepare<
          [string, string, string],
          {
            field: string;
            value: string | null;
            provenance: string | null;
            state: string;
            indexed_at: string;
          }
        >(
          `SELECT field, value, provenance, state, indexed_at
             FROM hbom_cells
            WHERE project_id = ?
              AND project_version_id = ?
              AND part_key = ?
            ORDER BY field`,
        )
        .all(scope.projectId, scope.projectVersionId, partKey);
      if (rows.length === 0) continue;
      const cells = rows
        .slice(0, 12)
        .map((row) => {
          let display = row.value ?? "—";
          if (row.value) {
            try {
              const parsed: unknown = JSON.parse(row.value);
              if (typeof parsed === "string" || typeof parsed === "number") {
                display = String(parsed);
              } else if (Array.isArray(parsed)) {
                display = parsed
                  .filter((v): v is string => typeof v === "string")
                  .slice(0, 6)
                  .join(",");
              }
            } catch {
              display = row.value.slice(0, 80);
            }
          }
          return `${row.field}=${display} (${row.provenance ?? "unknown"}/${row.state})`;
        })
        .join("; ");
      return [
        `# ${partKey}`,
        "",
        `- Part key: ${partKey}`,
        `- Cells: ${cells}`,
        freshnessLine(rows[0]?.indexed_at, "hbom-mirror"),
        `- Directive: ::fs-component{part="${partKey}"}`,
        `- Query: inspect product-security/hbom/hbom.yaml for ${partKey}`,
      ].join("\n");
    }
    return missingContext(
      "fs-intel",
      itemId,
      "open product-security/hbom/hbom.yaml and search the part id/MPN",
    );
  }

  return missingContext(
    "fs-intel",
    itemId,
    "bb finite-state triage list / bom sbom list --json",
  );
}

async function resolveRuns(
  db: Database.Database,
  scopes: MentionScope[],
  itemId: string,
): Promise<string> {
  if (itemId.startsWith("run:")) {
    const runId = itemId.slice(4);
    try {
      const detail = getBenchRun(db, runId);
      if (detail) {
        const run = detail.run;
        return [
          `# ${run.runId}`,
          "",
          `- Tier: ${run.tier} / ${run.matrixTier}`,
          `- Status: ${run.status}`,
          `- Firmware digest: ${run.firmwareDigest ?? "none"}`,
          `- Target: ${run.target ?? "none"}`,
          freshnessLine(run.syncedAt, detail.cache.state),
          `- Directive: ::fs-bench{id="${run.runId}"}`,
          `- Query: bb finite-state bench show ${run.runId}`,
        ].join("\n");
      }
    } catch {
      // Ambiguous without scope — try scoped lookups below.
    }
    for (const scope of scopes) {
      const page = listBenchRuns(db, {
        projectId: scope.projectId,
        pvId: scope.projectVersionId,
        pageSize: 50,
        continuation: null,
      });
      const run = page.items.find((item) => item.runId === runId);
      if (!run) continue;
      return [
        `# ${run.runId}`,
        "",
        `- Tier: ${run.tier}`,
        `- Status: ${run.status}`,
        `- Firmware digest: ${run.firmwareDigest ?? "none"}`,
        freshnessLine(run.syncedAt, page.cache.state),
        `- Directive: ::fs-bench{id="${run.runId}"}`,
        `- Query: bb finite-state bench show ${run.runId}`,
      ].join("\n");
    }
    return missingContext(
      "fs-runs",
      itemId,
      `bb finite-state bench list --json and look for ${runId}`,
    );
  }

  if (itemId.startsWith("verdict:")) {
    const digest = itemId.slice(8);
    for (const scope of scopes) {
      if (scope.projectVersionId === null) continue;
      try {
        const verdict = await getOtaVerdict(
          { db, projectId: scope.projectId },
          scope.projectVersionId,
          digest,
        );
        return [
          `# verdict-${digest.slice(0, 12)}`,
          "",
          `- PV: ${verdict.pvId}`,
          `- Firmware digest: ${verdict.firmwareDigest ?? digest}`,
          `- Verdict: ${verdict.verdict}`,
          `- Coverage: proven=${verdict.proven}/${verdict.required} failed=${verdict.failed} gaps=${verdict.gaps}`,
          `- Stale: ${verdict.stale ? "yes" : "no"}`,
          freshnessLine(verdict.computedAt, "computed"),
          `- Directive: ::fs-verdict{id="${digest}"}`,
          `- Query: bb finite-state bench verdict ${scope.projectVersionId}`,
        ].join("\n");
      } catch {
        // Try next scope.
      }
    }
    return missingContext(
      "fs-runs",
      itemId,
      "bb finite-state bench verdict <pv_id>",
    );
  }

  return missingContext("fs-runs", itemId, "bb finite-state bench list --json");
}

export async function resolveProvider(
  provider: MentionProviderId,
  db: Database.Database,
  projectId: string | null,
  itemId: string,
  hooks: MentionResolveHooks = {},
  log?: {
    warn: (msg: string) => void;
  },
): Promise<{ context: string }> {
  const budget = hooks.contextBudgetBytes ?? SOFT_RESPONSE_BYTES;
  try {
    const scopes = resolveMentionScopes(db, projectId);
    const override = hooks.resolvers?.[provider];
    const raw = override
      ? await override(db, scopes, itemId)
      : provider === "fs-model"
        ? resolveModel(db, scopes, itemId)
        : provider === "fs-docs"
          ? resolveDocs(db, scopes, itemId)
          : provider === "fs-intel"
            ? resolveIntel(db, scopes, itemId)
            : await resolveRuns(db, scopes, itemId);
    return { context: clampContext(raw, budget) };
  } catch (error) {
    log?.warn(
      `mention resolve failed provider=${provider} itemId=${itemId} error=${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      context: clampContext(
        [
          `# Mention resolution error (${provider})`,
          "",
          `- Id: ${itemId}`,
          `- Status: resolver failed safely`,
          `- Recovery: re-run the matching bb finite-state query for this id`,
          `- Detail: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        ].join("\n"),
        budget,
      ),
    };
  }
}
