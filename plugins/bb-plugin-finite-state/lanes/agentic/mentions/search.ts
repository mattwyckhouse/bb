import type Database from "better-sqlite3";
import type { PluginMentionItem } from "@bb/plugin-sdk";

import { SOFT_RESPONSE_BYTES } from "../../../lib/agentic/budget.js";
import { queryFindings } from "../../findings/cache/query.js";
import { querySbomForProject } from "../../bom/sbom/query.js";
import { listDocuments } from "../../documents/search.js";
import { listBenchRuns } from "../../bench/store/runs.js";

export const SEARCH_DEADLINE_MS = 2_000;
export const SEARCH_RESULT_CAP = 10;
export const CONTEXT_BUDGET_BYTES = SOFT_RESPONSE_BYTES;

export type MentionProviderId = "fs-model" | "fs-docs" | "fs-intel" | "fs-runs";

export interface MentionScope {
  projectId: string;
  projectVersionId: string | null;
}

export interface RankedCandidate {
  id: string;
  title: string;
  subtitle?: string;
  /** Lower is better. 0 = exact id, 1 = id prefix, 2 = name prefix, 3 = name contains. */
  rank: number;
  /** Dedup key within a provider (fs-intel component consolidation). */
  dedupeKey?: string;
}

export type ProviderSearchFn = (
  db: Database.Database,
  scope: MentionScope,
  query: string,
  signal: AbortSignal,
) => Promise<RankedCandidate[]> | RankedCandidate[];

export interface MentionSearchHooks {
  searchers?: Partial<Record<MentionProviderId, ProviderSearchFn>>;
  now?: () => number;
  deadlineMs?: number;
  resultCap?: number;
}

function escapeDisplay(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .slice(0, 240);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function rankMatch(query: string, id: string, name: string): number | null {
  const q = normalize(query);
  if (q.length === 0) return 3;
  const nid = normalize(id);
  const nname = normalize(name);
  if (nid === q) return 0;
  if (nid.startsWith(q)) return 1;
  if (nname === q || nname.startsWith(q)) return 2;
  if (nid.includes(q) || nname.includes(q)) return 3;
  return null;
}

function toItems(
  candidates: RankedCandidate[],
  cap: number,
): PluginMentionItem[] {
  const seen = new Set<string>();
  const ranked = [...candidates].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.id.localeCompare(right.id);
  });
  const items: PluginMentionItem[] = [];
  for (const candidate of ranked) {
    const dedupe = candidate.dedupeKey ?? candidate.id;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    items.push({
      id: candidate.id,
      title: escapeDisplay(candidate.title),
      ...(candidate.subtitle === undefined
        ? {}
        : { subtitle: escapeDisplay(candidate.subtitle) }),
    });
    if (items.length >= cap) break;
  }
  return items;
}

/**
 * Resolve concrete Platform/repo-local project+version scopes for cache reads.
 * Prefer an explicit binding when the composer project is a bb workspace id.
 * When projectId is null (send-time resolve without composer scope), fall back
 * to recently accepted cache scopes so resolve can still find the item.
 */
export function resolveMentionScopes(
  db: Database.Database,
  projectId: string | null,
): MentionScope[] {
  if (projectId !== null && projectId.length > 0) {
    const bound = db
      .prepare<[string], { platform_project_id: string }>(
        `SELECT platform_project_id
           FROM workspace_platform_project_binding
          WHERE workspace_project_id = ?
          ORDER BY platform_project_id`,
      )
      .all(projectId)
      .map((row) => row.platform_project_id);

    const projectIds = bound.length > 0 ? bound : [projectId];
    const scopes: MentionScope[] = [];
    for (const pid of projectIds) {
      const row = db
        .prepare<
          [string],
          { project_version_id: string; last_pull: string | null }
        >(
          `SELECT project_version_id, MAX(last_pull) AS last_pull
             FROM sync_state
            WHERE project_id = ?
              AND accepted_generation_id IS NOT NULL
            GROUP BY project_version_id
            ORDER BY last_pull DESC, project_version_id DESC
            LIMIT 1`,
        )
        .get(pid);
      if (row) {
        scopes.push({
          projectId: pid,
          projectVersionId: row.project_version_id,
        });
        // Documents are frequently project-scoped (@project); always include
        // the project-level ledger alongside the latest version cache.
        scopes.push({ projectId: pid, projectVersionId: null });
        continue;
      }
      scopes.push({ projectId: pid, projectVersionId: null });
    }
    return scopes;
  }

  const rows = db
    .prepare<[], { project_id: string; project_version_id: string }>(
      `SELECT project_id, project_version_id
         FROM sync_state
        WHERE accepted_generation_id IS NOT NULL
        GROUP BY project_id, project_version_id
        ORDER BY MAX(last_pull) DESC, project_id, project_version_id
        LIMIT 8`,
    )
    .all();
  if (rows.length > 0) {
    return rows.map((row) => ({
      projectId: row.project_id,
      projectVersionId: row.project_version_id,
    }));
  }

  const docs = db
    .prepare<[], { project_id: string; project_version_id: string }>(
      `SELECT project_id, project_version_id
         FROM document
        GROUP BY project_id, project_version_id
        ORDER BY MAX(uploaded_at) DESC
        LIMIT 8`,
    )
    .all();
  return docs.map((row) => ({
    projectId: row.project_id,
    projectVersionId:
      row.project_version_id === "@project" ? null : row.project_version_id,
  }));
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Mention search aborted");
    error.name = "AbortError";
    throw error;
  }
}

function searchModel(
  db: Database.Database,
  scope: MentionScope,
  query: string,
  signal: AbortSignal,
): RankedCandidate[] {
  assertNotAborted(signal);
  if (scope.projectVersionId === null) return [];
  const kinds = ["requirement", "threat", "component", "dataflow"] as const;
  const out: RankedCandidate[] = [];
  for (const kind of kinds) {
    assertNotAborted(signal);
    const rows = db
      .prepare<
        [string, string, string],
        { entity_key: string; payload: string }
      >(
        `SELECT b.entity_key, b.payload
           FROM base_snapshot b
           JOIN sync_state s
             ON s.project_id = b.project_id
            AND s.project_version_id = b.project_version_id
            AND s.entity_kind = b.entity_kind
            AND s.accepted_generation_id = b.generation_id
          WHERE b.project_id = ?
            AND b.project_version_id = ?
            AND b.entity_kind = ?
          ORDER BY b.entity_key`,
      )
      .all(scope.projectId, scope.projectVersionId, kind);
    for (const row of rows) {
      let label = row.entity_key;
      try {
        const payload: unknown = JSON.parse(row.payload);
        if (
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload)
        ) {
          const name = Reflect.get(payload, "name");
          const title = Reflect.get(payload, "title");
          if (typeof name === "string" && name.length > 0) label = name;
          else if (typeof title === "string" && title.length > 0) label = title;
        }
      } catch {
        // Keep the stable key when payload is malformed.
      }
      const rank = rankMatch(query, row.entity_key, label);
      if (rank === null) continue;
      out.push({
        id: row.entity_key,
        title: row.entity_key,
        subtitle: `${kind} · ${label}`,
        rank,
      });
    }
  }

  assertNotAborted(signal);
  const checks = db
    .prepare<[string, string], { code: string; name: string }>(
      `SELECT c.code, c.name
         FROM verification_checks c
        WHERE c.project_id = ?
          AND c.project_version_id = ?
          AND c.deleted_at IS NULL
          AND c.generation_id IN (
            SELECT accepted_generation_id FROM sync_state
             WHERE project_id = c.project_id
               AND project_version_id = c.project_version_id
               AND accepted_generation_id IS NOT NULL
          )
        ORDER BY c.code`,
    )
    .all(scope.projectId, scope.projectVersionId);
  for (const check of checks) {
    const rank = rankMatch(query, check.code, check.name);
    if (rank === null) continue;
    out.push({
      id: check.code,
      title: check.code,
      subtitle: `check · ${check.name}`,
      rank,
    });
  }
  return out;
}

function searchDocs(
  db: Database.Database,
  scope: MentionScope,
  query: string,
  signal: AbortSignal,
): RankedCandidate[] {
  assertNotAborted(signal);
  const page = listDocuments(db, scope, {
    pageSize: 50,
    continuation: null,
    filters: {},
  });
  const q = normalize(query).replace(/^datasheet:/, "");
  const out: RankedCandidate[] = [];
  for (const item of page.items) {
    assertNotAborted(signal);
    const sha =
      typeof item.fields.sha256 === "string" ? item.fields.sha256 : item.key;
    const kind =
      typeof item.fields.docKind === "string"
        ? item.fields.docKind
        : "document";
    const rank = rankMatch(q, sha, item.label);
    if (rank === null && q.length > 0) {
      const slug = normalize(item.label).replace(/[^a-z0-9]+/g, "");
      const qslug = q.replace(/[^a-z0-9]+/g, "");
      if (qslug.length === 0 || !slug.includes(qslug)) continue;
      out.push({
        id: `doc:${sha}`,
        title: item.label,
        subtitle: `${kind} · ${sha.slice(0, 12)}…`,
        rank: 3,
      });
      continue;
    }
    if (rank === null) continue;
    out.push({
      id: `doc:${sha}`,
      title: item.label,
      subtitle: `${kind} · ${sha.slice(0, 12)}…`,
      rank,
    });
  }
  return out;
}

function componentDedupeKey(name: string, purl: string | null): string {
  if (purl && purl.length > 0) return `purl:${normalize(purl)}`;
  return `name:${normalize(name)}`;
}

function searchIntel(
  db: Database.Database,
  scope: MentionScope,
  query: string,
  signal: AbortSignal,
): RankedCandidate[] {
  assertNotAborted(signal);
  if (scope.projectVersionId === null) return [];
  const out: RankedCandidate[] = [];
  const q = query.trim();

  if (cveRoute(q) || q.length === 0 || !q.includes("pkg:")) {
    const findings = queryFindings(db, {
      projectId: scope.projectId,
      pvId: scope.projectVersionId,
      ...(q.length > 0 ? { cve: q } : {}),
      limit: 50,
    });
    for (const finding of findings.items) {
      assertNotAborted(signal);
      const idLabel = finding.cve ?? finding.stableKey;
      const rank = rankMatch(
        q,
        idLabel,
        `${finding.componentName ?? ""} ${finding.title ?? ""}`,
      );
      if (rank === null) continue;
      out.push({
        id: `cve:${idLabel}`,
        title: idLabel,
        subtitle: [
          finding.componentName,
          finding.severity,
          finding.vexStatus ?? finding.localState,
        ]
          .filter(
            (part): part is string =>
              typeof part === "string" && part.length > 0,
          )
          .join(" · "),
        rank,
        dedupeKey: `cve:${normalize(idLabel)}`,
      });
      if (finding.componentName) {
        const compRank = rankMatch(
          q,
          finding.componentPurl ?? finding.componentName,
          finding.componentName,
        );
        if (compRank !== null) {
          out.push({
            id: `sbom:${finding.componentPurl ?? finding.componentName}`,
            title: finding.componentName,
            subtitle: finding.componentPurl ?? "component",
            rank: compRank,
            dedupeKey: componentDedupeKey(
              finding.componentName,
              finding.componentPurl,
            ),
          });
        }
      }
    }
  }

  assertNotAborted(signal);
  if (
    mpnRoute(q) === false ||
    q.length === 0 ||
    q.includes("pkg:") ||
    cveRoute(q) === false
  ) {
    const sbom = querySbomForProject(db, scope.projectId, {
      projectVersionId: scope.projectVersionId,
      ...(q.length > 0
        ? q.startsWith("pkg:")
          ? { purl: q }
          : { search: q }
        : {}),
      limit: 50,
    });
    for (const component of sbom.items) {
      assertNotAborted(signal);
      const rank = rankMatch(
        q,
        component.purl ?? component.componentKey,
        component.name,
      );
      if (rank === null) continue;
      out.push({
        id: `sbom:${component.componentKey}`,
        title: component.name,
        subtitle: component.purl ?? component.componentKey,
        rank,
        dedupeKey: componentDedupeKey(component.name, component.purl),
      });
    }
  }

  assertNotAborted(signal);
  if (mpnRoute(q) || q.length === 0 || (!cveRoute(q) && !q.includes("pkg:"))) {
    const like = `%${escapeLike(q)}%`;
    const hbom = db
      .prepare<
        [string, string, string, string, string],
        { part_key: string; field: string; value: string | null }
      >(
        `SELECT part_key, field, value
           FROM hbom_cells
          WHERE project_id = ?
            AND project_version_id = ?
            AND field IN ('mpn', 'partNumber', 'referenceDesignators')
            AND (
              ? = ''
              OR part_key LIKE ? ESCAPE '\\'
              OR IFNULL(value, '') LIKE ? ESCAPE '\\'
            )
          ORDER BY part_key, field`,
      )
      .all(
        scope.projectId,
        scope.projectVersionId,
        q,
        q.length === 0 ? "%" : like,
        q.length === 0 ? "%" : like,
      );
    for (const row of hbom) {
      assertNotAborted(signal);
      let display = row.part_key;
      if (typeof row.value === "string" && row.value.length > 0) {
        try {
          const parsed: unknown = JSON.parse(row.value);
          if (typeof parsed === "string") display = parsed;
          else if (Array.isArray(parsed)) {
            display = parsed
              .filter((v): v is string => typeof v === "string")
              .join(", ");
          }
        } catch {
          display = row.value;
        }
      }
      const rank = rankMatch(q, row.part_key, display);
      if (rank === null) continue;
      out.push({
        id: `hbom:${row.part_key}`,
        title: row.part_key,
        subtitle: `${row.field} · ${display}`,
        rank,
        dedupeKey: `hbom:${normalize(row.part_key)}`,
      });
    }
  }

  return out;
}

function cveRoute(query: string): boolean {
  return /^(CVE|GHSA)-/i.test(query.trim());
}

function mpnRoute(query: string): boolean {
  const q = query.trim();
  if (q.length === 0) return false;
  if (cveRoute(q) || q.includes("pkg:")) return false;
  // Part numbers / MPNs are typically alphanumeric without path separators.
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(q) && !q.includes("@");
}

function searchRuns(
  db: Database.Database,
  scope: MentionScope,
  query: string,
  signal: AbortSignal,
): RankedCandidate[] {
  assertNotAborted(signal);
  // Bench evidence is version-scoped; skip the project-level document scope.
  if (scope.projectVersionId === null) return [];
  const page = listBenchRuns(db, {
    projectId: scope.projectId,
    pvId: scope.projectVersionId,
    pageSize: 50,
    continuation: null,
  });
  const out: RankedCandidate[] = [];
  const digests = new Set<string>();
  for (const run of page.items) {
    assertNotAborted(signal);
    const aliases = [
      run.runId,
      `bench-run-${run.runId}`,
      run.firmwareDigest ?? "",
    ];
    let best: number | null = null;
    for (const alias of aliases) {
      if (alias.length === 0) continue;
      const rank = rankMatch(query, alias, `${run.tier} ${run.status}`);
      if (rank !== null && (best === null || rank < best)) best = rank;
    }
    if (best !== null) {
      out.push({
        id: `run:${run.runId}`,
        title: run.runId,
        subtitle: `${run.tier} · ${run.status}`,
        rank: best,
      });
    }
    if (run.firmwareDigest && run.firmwareDigest.length === 64) {
      digests.add(run.firmwareDigest);
    }
  }
  for (const digest of digests) {
    const rank = rankMatch(
      query,
      digest,
      `verdict-${digest} verdict-${digest.slice(0, 12)}`,
    );
    if (rank === null) continue;
    out.push({
      id: `verdict:${digest}`,
      title: `verdict-${digest.slice(0, 12)}`,
      subtitle: "OTA verdict",
      rank,
    });
  }
  return out;
}

const DEFAULT_SEARCHERS: Record<MentionProviderId, ProviderSearchFn> = {
  "fs-model": searchModel,
  "fs-docs": searchDocs,
  "fs-intel": searchIntel,
  "fs-runs": searchRuns,
};

export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; error: unknown }
> {
  const controller = new AbortController();
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve("timeout");
      },
      Math.max(0, deadlineMs),
    );
  });
  try {
    const result = await Promise.race([
      work(controller.signal).then((value) => ({
        kind: "value" as const,
        value,
      })),
      timeout.then((kind) => ({ kind })),
    ]);
    if (result.kind === "timeout") {
      return {
        ok: false,
        reason: "timeout",
        error: new Error("Mention search deadline exceeded"),
      };
    }
    if (now() - started > deadlineMs) {
      return {
        ok: false,
        reason: "timeout",
        error: new Error("Mention search deadline exceeded"),
      };
    }
    return { ok: true, value: result.value };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, reason: "timeout", error };
    }
    return { ok: false, reason: "error", error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function searchProvider(
  provider: MentionProviderId,
  db: Database.Database,
  projectId: string | null,
  query: string,
  hooks: MentionSearchHooks = {},
  log?: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
  },
): Promise<PluginMentionItem[]> {
  const deadlineMs = hooks.deadlineMs ?? SEARCH_DEADLINE_MS;
  const cap = hooks.resultCap ?? SEARCH_RESULT_CAP;
  const searcher = hooks.searchers?.[provider] ?? DEFAULT_SEARCHERS[provider];
  const scopes = resolveMentionScopes(db, projectId);

  const raced = await withDeadline(
    async (signal) => {
      const all: RankedCandidate[] = [];
      for (const scope of scopes) {
        assertNotAborted(signal);
        try {
          const batch = await searcher(db, scope, query, signal);
          all.push(...batch);
        } catch (error) {
          if (signal.aborted) throw error;
          log?.debug(
            `mention search scope failed provider=${provider} project=${scope.projectId} error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return toItems(all, cap);
    },
    deadlineMs,
    hooks.now,
  );

  if (!raced.ok) {
    if (raced.reason === "timeout") {
      log?.debug(
        `mention search deadline provider=${provider} query=${query} deadlineMs=${deadlineMs}`,
      );
    } else {
      log?.warn(
        `mention search failed provider=${provider} query=${query} error=${raced.error instanceof Error ? raced.error.message : String(raced.error)}`,
      );
    }
    return [];
  }
  return raced.value;
}
