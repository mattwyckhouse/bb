import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@bb/plugin-sdk";
import { ZodError } from "zod";

import type { PluginContext } from "../../../lib/context.js";
import {
  BENCH_ACTION_SERVICE,
  VERIFICATION_ACTION_SERVICE,
  requireActionService,
  type ScopedBenchAction,
  type ScopedVerificationAction,
} from "../../../lib/agentic/action-allowlist.js";
import { parseFindingStableKey } from "../../../lib/sync/registry.js";
import { bindWorkspacePlatformProject } from "../../../lib/store/project-scope.js";
import { TRIAGE_WRITER_SERVICE, type TriageWriter } from "../tools/write.js";
import { triageSetSchema } from "../tools/write-schemas.js";
import { queryFindings } from "../../findings/cache/query.js";
import { acceptedPlatformProjectId } from "../../findings/rpc.js";
import { rebuildOverlayIndex } from "../../findings/overlay/indexer.js";
import { readOverlayFiles } from "../../findings/overlay/reader.js";
import {
  OverlayCasConflictError,
  setDecision,
  type OverlayWriteResult,
} from "../../findings/overlay/writer.js";
import type { DecisionInput } from "../../findings/overlay/schema.js";
import { applyPolicy, PolicyApplyError } from "../../findings/policy/apply.js";
import { handleSbomExportCli } from "../../bom/sbom/export-cli.js";
import type { SbomExportCliDeps } from "../../bom/sbom/export-cli.js";
import { querySbom } from "../../bom/sbom/query.js";
import { isHbomPartField } from "../../bom/hbom/cell-view.js";
import { handleHbomExportCli } from "../../bom/hbom/export/cli.js";
import { listHbomReview } from "../../bom/hbom/review.js";
import { seedHbomFromComponents } from "../../bom/hbom/seed.js";
import { HbomMissingError, readHbom } from "../../bom/hbom/yaml.js";
import { listDocuments, searchDocuments } from "../../documents/search.js";
import {
  getDocumentById,
  resolveProjectWorktreeRoot,
  uploadDocumentEnvelope,
} from "../../documents/store.js";
import { getTara, listTara } from "../../product-security/register.js";
import { createSdkRequirementRepository } from "../../product-security/requirements/cards/adapter.js";
import { loadRequirementCardModel } from "../../product-security/requirements/cards/query.js";
import { startConversion } from "../../product-security/requirements/conversion/report.js";
import type { ConversionDeps } from "../../product-security/requirements/conversion/bundle.js";
import { queryRequirementsTraceability } from "../../product-security/requirements/traceability/query.js";
import { queryVerificationMatrix } from "../../product-security/verifications/matrix/query.js";
import { isVerificationTier } from "../../product-security/verifications/matrix/status.js";
import { queryRunDetail } from "../../product-security/verifications/run-detail/query.js";
import { listBenchRuns, getBenchRun } from "../../bench/store/runs.js";
import type { NamespacedCliRunner } from "../../sync/cli.js";

import {
  AGENTIC_CLI_SLOT,
  FINITE_STATE_COMMAND,
  finiteStateUsage,
  renderFiniteStateHelp,
  HBOM_REVIEW_ROUTE,
  SYNC_REVIEW_ROUTE,
  withContributedSubtrees,
  type AgenticCliSlot,
} from "./metadata.js";
import {
  CliUsageError,
  parseFiniteStateArgv,
  type CliExit,
  type NativeCommand,
  type ParsedCommand,
} from "./parser.js";
import {
  capJsonList,
  encodeJson,
  failConfig,
  failConflict,
  failTransport,
  failUsage,
  flagBoolean,
  flagString,
  jsonOutput,
  renderTable,
  result,
  reviewHandoff,
} from "./render.js";

export type { CliExit };
export { parseFiniteStateArgv };

export interface CliServices {
  bb: BbPluginApi;
  ctx: PluginContext;
  syncRun: NamespacedCliRunner;
  context: PluginCliContext;
}

type JsonRecord = Record<string, unknown>;
type TaraShowKind = Parameters<typeof getTara>[2]["kind"];

interface HealthProbe {
  configured: boolean;
  reachable: boolean;
  detail: string | null;
}

interface OwnedRemoteBundle {
  platform: SbomExportCliDeps["platform"] & {
    health: () => Promise<HealthProbe>;
    listProjects: (page?: {
      pageSize?: number;
    }) => AsyncIterable<{ items: unknown[] }>;
  };
  assuranceStudio: {
    health: () => Promise<HealthProbe>;
  };
  forgeCompute: { health: () => Promise<HealthProbe> } | null;
}

interface RemoteFailureShape {
  message: string;
  code: string;
  service: string;
  status: number | null;
}

const TARA_SHOW_KINDS: readonly TaraShowKind[] = [
  "threat",
  "component",
  "zone",
  "asset",
  "dataflow",
];

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortSignal(context: PluginCliContext): AbortSignal {
  return context.signal ?? new AbortController().signal;
}

function asCliExit(code: number): CliExit {
  if (code === 0 || code === 2 || code === 3 || code === 4 || code === 5) {
    return code;
  }
  return 5;
}

const HELP_VALUE_OPTIONS = new Set([
  "--as-project",
  "--candidate",
  "--check",
  "--clause",
  "--cursor",
  "--evidence",
  "--expected-hash",
  "--filter",
  "--format",
  "--justification",
  "--kind",
  "--limit",
  "--output",
  "--pin",
  "--project",
  "--pv",
  "--reason",
  "--reqs",
  "--requirement",
  "--response",
  "--status",
  "--target",
  "--tier",
  "--type",
  "--version",
  "-o",
]);

function hasHelpFlag(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return true;
    if (arg !== undefined && HELP_VALUE_OPTIONS.has(arg)) index += 1;
  }
  return false;
}

async function collectRecords(
  pages: AsyncIterable<{ items: unknown[] }>,
): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for await (const page of pages) {
    for (const item of page.items) {
      if (isRecord(item)) rows.push(item);
    }
  }
  return rows;
}

function isRemoteFailure(error: unknown): error is RemoteFailureShape {
  if (typeof error !== "object" || error === null) return false;
  if (!("name" in error) || error.name !== "RemoteError") return false;
  const code = Reflect.get(error, "code");
  const service = Reflect.get(error, "service");
  const status = Reflect.get(error, "status");
  const message = Reflect.get(error, "message");
  return (
    typeof code === "string" &&
    typeof service === "string" &&
    typeof message === "string" &&
    (status === null || typeof status === "number")
  );
}

function formatRemote(error: RemoteFailureShape): string {
  const status = error.status === null ? "none" : String(error.status);
  return `${error.message}\ncode=${error.code} service=${error.service} status=${status}\n`;
}

function healthRow(
  name: string,
  health: HealthProbe,
): { name: string; state: string; message: string | null } {
  if (!health.configured) {
    return { name, state: "unconfigured", message: health.detail };
  }
  if (!health.reachable) {
    return { name, state: "unreachable", message: health.detail };
  }
  return { name, state: "connected", message: health.detail };
}

async function probeHealth(
  label: string,
  health: () => Promise<HealthProbe>,
): Promise<{ name: string; state: string; message: string | null }> {
  try {
    return healthRow(label, await health());
  } catch (error: unknown) {
    if (isRemoteFailure(error)) {
      return { name: label, state: error.code, message: error.message };
    }
    return {
      name: label,
      state: "error",
      message: error instanceof Error ? error.message : "health check failed",
    };
  }
}

async function requireThreadProject(
  context: PluginCliContext,
): Promise<string> {
  if (!context.projectId) {
    throw new CliUsageError(
      "SYNC_EXECUTION_CONTEXT_REQUIRED: invoke from a bb project thread",
    );
  }
  return context.projectId;
}

async function requireWorktree(
  bb: BbPluginApi,
  context: PluginCliContext,
): Promise<{ worktreeRoot: string; workspaceProjectId: string }> {
  if (!context.threadId) {
    throw new CliUsageError(
      "SYNC_EXECUTION_CONTEXT_REQUIRED: invoke from a bb thread; cwd is not trusted as a worktree identity",
    );
  }
  const thread = await bb.sdk.threads.get({ threadId: context.threadId });
  if (
    !thread.environmentId ||
    (context.projectId !== undefined && thread.projectId !== context.projectId)
  ) {
    throw new CliUsageError(
      "SYNC_EXECUTION_CONTEXT_INVALID: thread project/environment mismatch",
    );
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (environment.projectId !== thread.projectId || !environment.path) {
    throw new CliUsageError(
      "SYNC_EXECUTION_CONTEXT_INVALID: environment has no verified workspace path",
    );
  }
  return {
    worktreeRoot: environment.path,
    workspaceProjectId: thread.projectId,
  };
}

function ownedRemotes(ctx: PluginContext): OwnedRemoteBundle {
  return ctx.service<OwnedRemoteBundle>("remote-services", () => {
    throw new Error("REMOTE_SERVICES_NOT_REGISTERED");
  });
}

function syncArgv(
  command: NativeCommand,
  verb: string,
  forceJson = false,
): string[] {
  const argv = [verb];
  if (command.surface) argv.push(command.surface);
  if (command.projectId) argv.push("--project", command.projectId);
  if (command.projectVersionId)
    argv.push("--version", command.projectVersionId);
  if (command.projectLevel) argv.push("--project-level");
  if (forceJson || command.json) argv.push("--json");
  return argv;
}

function listedPayload(
  items: readonly unknown[],
  total: number,
  cursor: string | null,
  json: boolean,
  extras?: Record<string, unknown>,
): string {
  const capped = capJsonList(items, total, cursor, extras);
  return jsonOutput(capped.payload, json);
}

function platformProject(
  command: NativeCommand,
  context: PluginCliContext,
): string {
  if (command.projectId) return command.projectId;
  if (context.projectId) return context.projectId;
  throw new CliUsageError("--project is required");
}

function parsedTaraKind(flag: string | undefined, slug: string): TaraShowKind {
  if (flag) {
    const match = TARA_SHOW_KINDS.find((kind) => kind === flag);
    if (match === undefined) {
      throw new CliUsageError(`unknown TARA kind ${flag}`);
    }
    return match;
  }
  if (slug.startsWith("THREAT-")) return "threat";
  if (slug.startsWith("ZONE-")) return "zone";
  if (slug.startsWith("FLOW-")) return "dataflow";
  if (slug.startsWith("ASSET-")) return "asset";
  return "component";
}

function overlayDigest(
  files: Awaited<ReturnType<typeof readOverlayFiles>>["files"],
  project: string,
  component: DecisionInput["component"],
): string | undefined {
  const match = files.find(
    (candidate) =>
      candidate.overlay.project === project &&
      candidate.overlay.component.name === component.name &&
      candidate.overlay.component.group === component.group &&
      candidate.overlay.component.version === component.version &&
      candidate.overlay.component.purl === component.purl,
  );
  return match?.sha256;
}

function toLocalWrite(result: OverlayWriteResult) {
  const op =
    result.changedFields.length === 0 && result.beforeSha256 !== null
      ? ("noop" as const)
      : result.beforeSha256 === null
        ? ("create" as const)
        : ("update" as const);
  return {
    path: result.file,
    op,
    diffSummary: result.changedFields.map((field) => ({
      field,
      from: null as string | null,
      to: "updated" as string | null,
    })),
    omittedDiffs: 0,
    contentHash: result.afterSha256,
  };
}

function composeTriageWriter(
  bb: BbPluginApi,
  ctx: PluginContext,
): TriageWriter {
  return {
    async set(input, scope) {
      const root = await resolveProjectWorktreeRoot(bb, scope.projectId);
      const platformProjectId = acceptedPlatformProjectId(
        ctx.db(),
        scope.projectId,
        input.projectVersionId,
      );
      let cve: string;
      try {
        cve = parseFindingStableKey(input.stableKey).cve;
      } catch {
        throw new CliUsageError(
          `Stable key ${input.stableKey} is not a finding key`,
        );
      }
      const page = queryFindings(ctx.db(), {
        projectId: platformProjectId,
        pvId: input.projectVersionId,
        cve,
        limit: 200,
      });
      const finding = page.items.find(
        (item) => item.stableKey === input.stableKey,
      );
      if (!finding || !finding.cve || !finding.componentName) {
        throw new CliUsageError(
          `Stable key ${input.stableKey} does not resolve against the accepted findings cache.`,
        );
      }
      const component = {
        purl: finding.componentPurl,
        name: finding.componentName,
        group: finding.componentGroup,
        version: finding.componentVersion,
      };
      const corpus = await readOverlayFiles(root);
      const observedDigest = overlayDigest(
        corpus.files,
        finding.projectId,
        component,
      );
      if (input.expectedHash === undefined && observedDigest !== undefined) {
        throw new OverlayCasConflictError("overlay", undefined, observedDigest);
      }
      const decisionInput: DecisionInput = {
        project: finding.projectId,
        component,
        cve: finding.cve,
        stableKey: finding.stableKey,
        status: input.status,
        justification: input.justification,
        response: input.response,
        reason: input.reason,
        ...(input.pin !== undefined ? { pin: input.pin } : {}),
        provenance: {
          by: "bb-cli",
          at: new Date().toISOString(),
          evidence: input.evidence,
        },
      };
      const written = await setDecision(
        root,
        decisionInput,
        input.expectedHash ?? observedDigest,
      );
      await rebuildOverlayIndex(ctx.db(), root);
      return toLocalWrite(written);
    },
    async applyPolicy(input, scope) {
      const root = await resolveProjectWorktreeRoot(bb, scope.projectId);
      const platformProjectId = acceptedPlatformProjectId(
        ctx.db(),
        scope.projectId,
        input.projectVersionId,
      );
      const policyScope = {
        projectId: platformProjectId,
        projectVersionId: input.projectVersionId,
        project: platformProjectId,
      };
      const deps = { db: ctx.db(), root, signal: scope.signal };
      const evaluated = await applyPolicy(deps, policyScope, { dryRun: true });
      if (input.dryRun) {
        return {
          paths: [],
          written: 0,
          held: evaluated.held.map((item) => ({
            key: item.stableKey,
            rule: item.rule,
            why: item.why,
          })),
          skippedExisting: evaluated.skippedExisting,
          errors: evaluated.errors.map((error) => ({
            code: error.code,
            message: error.message,
            hint: "Inspect held/skipped keys; policy never overwrites existing decisions or KEV holdbacks.",
            retryable: false,
            details: { stableKey: error.stableKey ?? null },
          })),
          runId: evaluated.runId,
          dryRun: true,
          policySha256: evaluated.policySha256,
        };
      }
      const report = await applyPolicy(deps, policyScope, {
        dryRun: false,
        expectedPolicySha256: evaluated.policySha256,
        evaluated,
      });
      await rebuildOverlayIndex(ctx.db(), root);
      return {
        paths: [],
        written: report.written,
        held: report.held.map((item) => ({
          key: item.stableKey,
          rule: item.rule,
          why: item.why,
        })),
        skippedExisting: report.skippedExisting,
        errors: report.errors.map((error) => ({
          code: error.code,
          message: error.message,
          hint: "Inspect held/skipped keys; policy never overwrites existing decisions or KEV holdbacks.",
          retryable: false,
          details: { stableKey: error.stableKey ?? null },
        })),
        runId: report.runId,
        dryRun: false,
        policySha256: report.policySha256,
      };
    },
  };
}

function triageWriter(bb: BbPluginApi, ctx: PluginContext): TriageWriter {
  return ctx.service<TriageWriter>(TRIAGE_WRITER_SERVICE, () =>
    composeTriageWriter(bb, ctx),
  );
}

async function handleConnect(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const action = command.positional[0] ?? "status";
  if (action === "configure") {
    const payload = {
      settings: [
        "platformBaseUrl",
        "platformToken",
        "assuranceStudioBaseUrl",
        "asApiKey",
        "forgeUrl",
        "forgeCommand",
      ],
      guidance:
        "Configure with `bb plugin config finite-state set <key> <value>`. Optional Forge compute stays disabled until forgeUrl or forgeCommand is set.",
    };
    return result(0, jsonOutput(payload, command.json));
  }
  const remote = ownedRemotes(services.ctx);
  const platform = await probeHealth("platform", () =>
    remote.platform.health(),
  );
  const assuranceStudio = await probeHealth("assuranceStudio", () =>
    remote.assuranceStudio.health(),
  );
  let forgeCompute: { name: string; state: string; message: string | null };
  if (remote.forgeCompute === null) {
    forgeCompute = {
      name: "forgeCompute",
      state: "disabled",
      message:
        "Optional Forge compute is not enabled. Set forgeUrl or forgeCommand via `bb plugin config finite-state set`.",
    };
  } else {
    const forge = remote.forgeCompute;
    forgeCompute = await probeHealth("forgeCompute", () => forge.health());
  }
  const payload = { platform, assuranceStudio, forgeCompute };
  if (command.json) return result(0, encodeJson(payload));
  return result(
    0,
    renderTable(
      ["service", "state", "message"],
      [
        [platform.name, platform.state, platform.message ?? ""],
        [
          assuranceStudio.name,
          assuranceStudio.state,
          assuranceStudio.message ?? "",
        ],
        [forgeCompute.name, forgeCompute.state, forgeCompute.message ?? ""],
      ],
    ),
  );
}

async function handleProject(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const remote = ownedRemotes(services.ctx);
  if (command.family === "project-list") {
    const items = await collectRecords(
      remote.platform.listProjects({ pageSize: 200 }),
    );
    const rows = items.map((item) => [
      typeof item["id"] === "string" ? item["id"] : "",
      typeof item["name"] === "string" ? item["name"] : "",
    ]);
    if (command.json) {
      return result(0, listedPayload(items, items.length, null, true));
    }
    return result(0, renderTable(["id", "name"], rows));
  }
  const workspace = await requireThreadProject(services.context);
  const platformId = command.positional[0];
  if (!platformId) {
    throw new CliUsageError("project use requires a Platform project id");
  }
  bindWorkspacePlatformProject(services.ctx.db(), workspace, platformId);
  return result(
    0,
    jsonOutput(
      { workspaceProjectId: workspace, platformProjectId: platformId },
      command.json,
    ),
  );
}

async function handlePush(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const planned = await services.syncRun(
    syncArgv(command, "plan", true),
    services.context,
  );
  if (planned.exitCode !== 0 && planned.exitCode !== undefined) {
    return {
      exitCode: planned.exitCode,
      stdout: planned.stdout ?? "",
      stderr: planned.stderr ?? "",
    };
  }
  const parsed: unknown = JSON.parse((planned.stdout ?? "").trim() || "{}");
  const summary =
    isRecord(parsed) && isRecord(parsed["summary"]) ? parsed["summary"] : {};
  const blast =
    isRecord(parsed) && isRecord(parsed["blastRadius"])
      ? parsed["blastRadius"]
      : {};
  const conflicts =
    typeof summary["conflicts"] === "number" ? summary["conflicts"] : 0;
  const surfaces = Array.isArray(blast["surfaces"])
    ? blast["surfaces"].filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const line = `Unresolved conflicts: ${conflicts}. Blast radius: changed=${String(blast["changed"] ?? 0)} deletes=${String(blast["deletes"] ?? 0)} surfaces=${surfaces.join(",")}.`;
  return reviewHandoff({
    title: "Sync push requires human review.",
    route: SYNC_REVIEW_ROUTE,
    summary: line,
    json: command.json,
    extra: {
      plan: parsed,
      verb: "push",
      surface: command.surface,
    },
  });
}

async function handleTriageList(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const projectId = platformProject(command, services.context);
  const pvId = command.projectVersionId;
  if (!pvId) throw new CliUsageError("triage list requires --version");
  const filter = flagString(command.flags, "filter");
  const page = queryFindings(services.ctx.db(), {
    projectId,
    pvId,
    ...(filter ? { triage: [filter] } : {}),
    ...(command.cursor ? { cursor: command.cursor } : {}),
    ...(command.limit ? { limit: command.limit } : {}),
  });
  if (command.json) {
    return result(
      0,
      listedPayload(page.items, page.total, page.nextCursor, true, {
        facets: page.facets,
        cache: page.cache,
      }),
    );
  }
  return result(
    0,
    renderTable(
      ["stableKey", "cve", "severity", "status"],
      page.items.map((item) => [
        item.stableKey,
        item.cve ?? "",
        item.severity ?? "",
        item.vexStatus ?? "",
      ]),
    ),
  );
}

async function handleTriageWrite(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const workspaceProjectId = await requireThreadProject(services.context);
  const writer = triageWriter(services.bb, services.ctx);
  const projectVersionId = command.projectVersionId;
  if (!projectVersionId) throw new CliUsageError("--version is required");
  const signal = abortSignal(services.context);
  if (command.family === "triage-apply-policy") {
    const report = await writer.applyPolicy(
      {
        projectVersionId,
        dryRun: flagBoolean(command.flags, "dryRun"),
      },
      { projectId: workspaceProjectId, signal },
    );
    const exit: CliExit = report.errors.length > 0 ? 4 : 0;
    return result(exit, jsonOutput(report, command.json));
  }
  const parsed = triageSetSchema.safeParse({
    projectVersionId,
    stableKey: command.positional[0] ?? "",
    status: flagString(command.flags, "status"),
    justification: flagString(command.flags, "justification") ?? null,
    response: flagString(command.flags, "response") ?? null,
    reason: flagString(command.flags, "reason"),
    evidence: flagString(command.flags, "evidence"),
    ...(flagString(command.flags, "pin")
      ? { pin: flagString(command.flags, "pin") }
      : {}),
    ...(flagString(command.flags, "expectedHash")
      ? { expectedHash: flagString(command.flags, "expectedHash") }
      : {}),
  });
  if (!parsed.success) {
    throw new CliUsageError(
      parsed.error.issues[0]?.message ?? "invalid triage set",
    );
  }
  const written = await writer.set(parsed.data, {
    projectId: workspaceProjectId,
    signal,
  });
  return result(0, jsonOutput(written, command.json));
}

async function handleTaraShow(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const slug = command.positional[0] ?? "";
  const row = await getTara(services.bb, services.ctx.db(), {
    projectId: platformProject(command, services.context),
    projectVersionId: command.projectVersionId,
    kind: parsedTaraKind(flagString(command.flags, "kind"), slug),
    id: slug,
  });
  return result(0, jsonOutput(row, command.json));
}

async function handleReq(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const projectId = platformProject(command, services.context);
  const repository = createSdkRequirementRepository(services.bb);
  if (command.family === "req-show") {
    const reqId = command.positional[0] ?? "";
    const document = await repository.read(projectId, reqId);
    if (!document) return failConflict(`Requirement ${reqId} was not found.`);
    const card = loadRequirementCardModel(
      services.ctx.db(),
      { projectId, projectVersionId: command.projectVersionId },
      document.requirement,
      document.sha256,
    );
    return result(0, jsonOutput(card, command.json));
  }
  const status = flagString(command.flags, "status");
  const clause = flagString(command.flags, "clause");
  const listed = await queryRequirementsTraceability({
    bb: services.bb,
    ctx: services.ctx,
    repository,
    input: {
      projectId,
      projectVersionId: command.projectVersionId,
      pageSize: command.limit ?? 50,
      continuation: command.cursor,
      filters: {
        ...(status ? { evidenceState: [status] } : {}),
        ...(clause ? { standardClause: clause } : {}),
      },
    },
  });
  if (command.json) {
    return result(
      0,
      listedPayload(listed.items, listed.total, listed.next, true, {
        cache: listed.cache,
      }),
    );
  }
  return result(
    0,
    renderTable(
      ["id", "label"],
      listed.items.map((item) => [item.key, item.label]),
    ),
  );
}

async function handleEars(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const projectId = platformProject(command, services.context);
  const reqs = flagString(command.flags, "reqs");
  const deps: ConversionDeps = {
    projectId,
    projectVersionId: command.projectVersionId,
    async loadPullSnapshot() {
      return null;
    },
    async readLocalFile() {
      return null;
    },
    async spawnOriginPluginThread() {
      return { threadId: services.context.threadId ?? "conversion" };
    },
  };
  const report = await startConversion(
    deps,
    reqs
      ? reqs
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
  );
  const exit: CliExit = report.state === "failed" ? 3 : 0;
  return result(exit, jsonOutput(report, command.json));
}

async function handleVerify(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const projectId = platformProject(command, services.context);
  if (command.family === "verify-matrix") {
    const page = queryVerificationMatrix(services.ctx.db(), {
      projectId,
      projectVersionId: command.projectVersionId,
      pageSize: command.limit ?? 50,
      continuation: command.cursor,
      filters: flagBoolean(command.flags, "unproven") ? { unproven: true } : {},
    });
    if (command.json) {
      return result(
        0,
        listedPayload(page.items, page.total, page.next, true, {
          cache: page.cache,
        }),
      );
    }
    return result(
      0,
      renderTable(
        ["requirement", "label"],
        page.items.map((item) => [item.key, item.label]),
      ),
    );
  }
  if (command.family === "verify-run") {
    const action = requireActionService<ScopedVerificationAction>(
      services.ctx,
      VERIFICATION_ACTION_SERVICE,
    );
    const threadId = services.context.threadId;
    if (!threadId) {
      throw new CliUsageError("verify run requires a bb thread");
    }
    const started = await action.run(
      {
        requirement: command.positional[0] ?? "",
        ...(flagString(command.flags, "tier")
          ? { tier: flagString(command.flags, "tier") }
          : {}),
        ...(flagString(command.flags, "check")
          ? { check: flagString(command.flags, "check") }
          : {}),
      },
      {
        projectId,
        threadId,
        signal: abortSignal(services.context),
      },
    );
    return result(
      0,
      jsonOutput({ ...started, status: "queued" }, command.json),
    );
  }
  const tierFlag = flagString(command.flags, "tier");
  const tier = tierFlag && isVerificationTier(tierFlag) ? tierFlag : "static";
  try {
    const detail = queryRunDetail(services.ctx.db(), {
      projectId,
      projectVersionId: command.projectVersionId,
      requirementId: command.positional[0] ?? "",
      tier,
    });
    return result(0, jsonOutput(detail, command.json));
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes("VERIFICATION_DETAIL_EMPTY")
    ) {
      return failConflict("No cached verification results were found.");
    }
    throw error;
  }
}

async function handleBom(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const projectId = command.projectId ?? services.context.projectId ?? null;
  if (command.family === "bom-pull") {
    return services.syncRun(syncArgv(command, "pull"), services.context);
  }
  if (command.family === "bom-sbom-list") {
    if (!command.projectVersionId) {
      throw new CliUsageError("bom sbom list requires --version");
    }
    const page = querySbom(services.ctx.db(), {
      projectVersionId: command.projectVersionId,
      ...(command.cursor ? { cursor: command.cursor } : {}),
      ...(command.limit ? { limit: command.limit } : {}),
      ...(flagString(command.flags, "filter")
        ? { search: flagString(command.flags, "filter") }
        : {}),
    });
    if (command.json) {
      return result(
        0,
        listedPayload(page.items, page.total, page.cursor, true, {
          cache: page.cache,
        }),
      );
    }
    return result(
      0,
      renderTable(
        ["name", "purl", "version"],
        page.items.map((item) => [
          item.name,
          item.purl ?? "",
          item.version ?? "",
        ]),
      ),
    );
  }
  if (command.family === "bom-sbom-export") {
    const workspace = await requireWorktree(services.bb, services.context);
    const argv: string[] = [];
    if (command.projectVersionId)
      argv.push("--version", command.projectVersionId);
    const format = flagString(command.flags, "format");
    if (format) argv.push("--format", format);
    const output = flagString(command.flags, "output");
    if (output) argv.push("-o", output);
    if (command.flags.includeVex === false) argv.push("--no-include-vex");
    if (command.flags.includeVex === true) argv.push("--include-vex");
    if (command.json) argv.push("--json");
    const remote = ownedRemotes(services.ctx);
    return handleSbomExportCli(
      {
        platform: remote.platform,
        permittedOutputRoot: workspace.worktreeRoot,
      },
      argv,
      services.context,
    );
  }
  const workspace = await requireWorktree(services.bb, services.context);
  if (command.family === "bom-hbom-seed") {
    const listed = await listTara(
      services.bb,
      services.ctx.db(),
      {
        projectId: projectId ?? workspace.workspaceProjectId,
        projectVersionId: command.projectVersionId,
        kind: "component",
        pageSize: 500,
        continuation: null,
        filters: {},
      },
      {
        workspaceProjectId: workspace.workspaceProjectId,
        platformProjectId: projectId ?? workspace.workspaceProjectId,
      },
    );
    const seeded = await seedHbomFromComponents({
      root: workspace.worktreeRoot,
      project: projectId ?? workspace.workspaceProjectId,
      components: listed.items.map((item) => ({
        id: item.key,
        componentType: "hardware",
        name: item.label,
      })),
    });
    return result(
      0,
      jsonOutput(
        {
          sha256: seeded.sha256,
          created: seeded.created,
          updated: seeded.updated,
          markedMissing: seeded.markedMissing,
          unchanged: seeded.unchanged,
        },
        command.json,
      ),
    );
  }
  if (command.family === "bom-hbom-ingest") {
    const file = command.positional[0];
    if (!file) throw new CliUsageError("bom hbom ingest requires a file");
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const kind = flagString(command.flags, "kind") ?? "other";
    const uploaded = await uploadDocumentEnvelope(
      services.ctx.db(),
      services.bb,
      {
        envelopeVersion: 1,
        projectId: projectId ?? workspace.workspaceProjectId,
        projectVersionId: command.projectVersionId,
        filename: basename(file),
        sha256,
        contentBase64: bytes.toString("base64"),
        metadata: { kind },
      },
      (payload) => {
        services.bb.realtime.publish("documents:changed", payload);
      },
    );
    const extra = flagBoolean(command.flags, "extract")
      ? {
          extract: false,
          hint: `Document ingested. Extraction merge uses local YAML via the HBOM review panel at ${HBOM_REVIEW_ROUTE}; the CLI does not call hbom.review.resolve or hbomExtractionApply.`,
        }
      : {};
    return result(0, jsonOutput({ ...uploaded, ...extra }, command.json));
  }
  if (command.family === "bom-hbom-status") {
    try {
      const current = await readHbom(workspace.worktreeRoot);
      return result(
        0,
        jsonOutput(
          {
            path: "product-security/hbom/hbom.yaml",
            sha256: current.sha256,
            parts: current.document.parts.length,
          },
          command.json,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof HbomMissingError) {
        return result(
          0,
          jsonOutput({ missing: true, sha256: null }, command.json),
        );
      }
      throw error;
    }
  }
  if (command.family === "bom-hbom-review") {
    const page = await listHbomReview(
      { db: services.ctx.db(), root: workspace.worktreeRoot },
      {
        projectId: projectId ?? workspace.workspaceProjectId,
        projectVersionId: command.projectVersionId,
        pageSize: command.limit ?? 50,
        continuation: command.cursor,
        filters: {},
      },
    );
    if (command.json) {
      return result(
        0,
        listedPayload(page.items, page.total, page.next, true, {
          cache: page.cache,
        }),
      );
    }
    return result(
      0,
      renderTable(
        ["id", "part", "field"],
        page.items.map((item) => [
          item.key,
          String(item.fields["partId"] ?? ""),
          String(item.fields["field"] ?? ""),
        ]),
      ),
    );
  }
  if (
    command.family === "bom-hbom-accept" ||
    command.family === "bom-hbom-reject"
  ) {
    const part = command.positional[0] ?? "";
    const field = command.positional[1] ?? "";
    if (!isHbomPartField(field)) {
      throw new CliUsageError(`unknown HBOM field ${field}`);
    }
    const page = await listHbomReview(
      { db: services.ctx.db(), root: workspace.worktreeRoot },
      {
        projectId: projectId ?? workspace.workspaceProjectId,
        projectVersionId: command.projectVersionId,
        pageSize: 200,
        continuation: null,
        filters: {},
      },
    );
    const match = page.items.some(
      (item) =>
        (item.key.includes(part) ||
          String(item.fields["partId"] ?? "") === part) &&
        String(item.fields["field"] ?? "") === field,
    );
    if (!match) {
      return failConflict(`HBOM review item ${part}/${field} was not found.`);
    }
    return reviewHandoff({
      title: `HBOM ${command.family === "bom-hbom-accept" ? "accept" : "reject"} requires the human review panel.`,
      route: HBOM_REVIEW_ROUTE,
      summary: `Selected part=${part} field=${field} candidate=${flagString(command.flags, "candidate") ?? "default"}. The CLI did not invoke hbom.review.resolve.`,
      json: command.json,
      extra: {
        part,
        field,
        action: command.family === "bom-hbom-accept" ? "accept" : "reject",
      },
    });
  }
  const argv: string[] = [];
  if (flagBoolean(command.flags, "xlsx")) argv.push("--xlsx");
  if (flagBoolean(command.flags, "cdx")) argv.push("--cdx");
  if (flagBoolean(command.flags, "verifiedOnly")) argv.push("--verified-only");
  const output = flagString(command.flags, "output");
  if (output) argv.push("-o", output);
  if (command.json) argv.push("--json");
  return handleHbomExportCli(
    {
      db: services.ctx.db(),
      root: workspace.worktreeRoot,
      projectId: projectId ?? workspace.workspaceProjectId,
      projectVersionId: command.projectVersionId,
      permittedOutputRoot: workspace.worktreeRoot,
    },
    argv,
    services.context,
  );
}

async function handleBench(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const projectId = await requireThreadProject(services.context);
  if (command.family === "bench-run") {
    const action = requireActionService<ScopedBenchAction>(
      services.ctx,
      BENCH_ACTION_SERVICE,
    );
    const threadId = services.context.threadId;
    if (!threadId) throw new CliUsageError("bench run requires a bb thread");
    const started = await action.run(
      {
        pvId: command.positional[0] ?? "",
        tier: flagString(command.flags, "tier") ?? "tier0",
        ...(flagString(command.flags, "requirement")
          ? { requirement: flagString(command.flags, "requirement") }
          : {}),
        ...(flagString(command.flags, "target")
          ? { target: flagString(command.flags, "target") }
          : {}),
      },
      {
        projectId,
        threadId,
        signal: abortSignal(services.context),
      },
    );
    return result(0, jsonOutput(started, command.json));
  }
  if (command.family === "bench-list") {
    let page: ReturnType<typeof listBenchRuns>;
    try {
      page = listBenchRuns(services.ctx.db(), {
        projectId,
        pvId: flagString(command.flags, "pv") ?? command.projectVersionId,
        pageSize: command.limit ?? 50,
        continuation: command.cursor,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes(
          "requires an accepted verificationRun generation",
        )
      ) {
        page = {
          items: [],
          total: 0,
          next: null,
          cache: {
            state: "empty",
            asOf: null,
            message: error.message,
            acceptedGenerationId: null,
            baseRevision: 0,
          },
        };
      } else {
        throw error;
      }
    }
    const items = flagBoolean(command.flags, "failing")
      ? page.items.filter((item) => item.status === "failed")
      : page.items;
    if (command.json) {
      return result(
        0,
        listedPayload(items, page.total, page.next, true, {
          cache: page.cache,
        }),
      );
    }
    return result(
      0,
      renderTable(
        ["runId", "tier", "status"],
        items.map((item) => [item.runId, item.tier, item.status]),
      ),
    );
  }
  const shown = getBenchRun(services.ctx.db(), command.positional[0] ?? "");
  if (!shown) return failConflict("Bench run was not found.");
  return result(0, jsonOutput(shown, command.json));
}

async function handleDoc(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  const scope = {
    projectId: platformProject(command, services.context),
    projectVersionId: command.projectVersionId,
  };
  if (command.family === "doc-show") {
    const doc = getDocumentById(
      services.ctx.db(),
      scope,
      command.positional[0] ?? "",
    );
    if (!doc) return failConflict("Document was not found.");
    return result(0, jsonOutput(doc, command.json));
  }
  if (command.family === "doc-search") {
    const page = searchDocuments(services.ctx.db(), scope, {
      query: command.positional.join(" "),
      pageSize: command.limit ?? 50,
      continuation: command.cursor,
    });
    if (command.json) {
      return result(
        0,
        listedPayload(
          page.items,
          page.total ?? page.items.length,
          page.next,
          true,
        ),
      );
    }
    return result(
      0,
      renderTable(
        ["document", "field"],
        page.items.map((item) => [item.documentName, item.field]),
      ),
    );
  }
  const page = listDocuments(services.ctx.db(), scope, {
    pageSize: command.limit ?? 50,
    continuation: command.cursor,
    filters: {
      ...(flagString(command.flags, "type")
        ? { kind: flagString(command.flags, "type") }
        : {}),
    },
  });
  if (command.json) {
    return result(
      0,
      listedPayload(
        page.items,
        page.total ?? page.items.length,
        page.next,
        true,
      ),
    );
  }
  return result(
    0,
    renderTable(
      ["id", "label"],
      page.items.map((item) => [item.key, item.label]),
    ),
  );
}

async function handleNative(
  services: CliServices,
  command: NativeCommand,
): Promise<PluginCliResult> {
  switch (command.family) {
    case "connect":
      return handleConnect(services, command);
    case "project-list":
    case "project-use":
      return handleProject(services, command);
    case "push":
      return handlePush(services, command);
    case "triage-list":
      return handleTriageList(services, command);
    case "triage-set":
    case "triage-apply-policy":
      return handleTriageWrite(services, command);
    case "tara-show":
      return handleTaraShow(services, command);
    case "req-list":
    case "req-show":
      return handleReq(services, command);
    case "ears-convert":
      return handleEars(services, command);
    case "verify-matrix":
    case "verify-run":
    case "verify-results":
      return handleVerify(services, command);
    case "bom-pull":
    case "bom-sbom-list":
    case "bom-sbom-export":
    case "bom-hbom-seed":
    case "bom-hbom-ingest":
    case "bom-hbom-status":
    case "bom-hbom-review":
    case "bom-hbom-accept":
    case "bom-hbom-reject":
    case "bom-hbom-export":
      return handleBom(services, command);
    case "bench-run":
    case "bench-list":
    case "bench-show":
      return handleBench(services, command);
    case "doc-list":
    case "doc-show":
    case "doc-search":
      return handleDoc(services, command);
    default: {
      const exhaustive: never = command.family;
      return failUsage(`unhandled command ${exhaustive}`);
    }
  }
}

export async function runFiniteStateCommand(
  command: ParsedCommand,
  services: CliServices,
): Promise<CliExit> {
  const outcome = await executeCommand(command, services);
  return asCliExit(outcome.exitCode);
}

async function executeCommand(
  command: ParsedCommand,
  services: CliServices,
): Promise<PluginCliResult> {
  try {
    if (command.kind === "legacy") {
      return await services.syncRun(command.argv, services.context);
    }
    return await handleNative(services, command);
  } catch (error: unknown) {
    if (error instanceof CliUsageError) return failUsage(error.message);
    if (error instanceof ZodError) {
      return failUsage(error.issues[0]?.message ?? "invalid arguments");
    }
    if (error instanceof OverlayCasConflictError) {
      return failConflict(error.message);
    }
    if (error instanceof PolicyApplyError) {
      return failConflict(error.message);
    }
    if (isRemoteFailure(error)) {
      return { exitCode: 1, stdout: "", stderr: formatRemote(error) };
    }
    if (error instanceof Error && error.message.includes("NOT_REGISTERED")) {
      return failConfig(error.message);
    }
    if (error instanceof Error) {
      if (
        error.message.startsWith("unknown option ") ||
        error.message.startsWith("unexpected argument ") ||
        error.message.includes(" requires a value") ||
        error.message.includes(" accepts only ")
      ) {
        return failUsage(error.message);
      }
      const conflict =
        error.message.includes("CAS") ||
        error.message.includes("cas_mismatch") ||
        error.message.includes("STALE") ||
        error.message.includes("conflict") ||
        error.message.includes("pull snapshot");
      if (conflict) return failConflict(error.message);
      return failTransport(error.message);
    }
    return failTransport("internal error");
  }
}

function createDispatcher(
  bb: BbPluginApi,
  ctx: PluginContext,
): NamespacedCliRunner {
  return async (argv, context) => {
    const sync = ctx.service<{ run: NamespacedCliRunner }>("sync.cli", () => ({
      run: async () => failConfig("Sync CLI services are unavailable"),
    }));
    const services: CliServices = {
      bb,
      ctx,
      syncRun: sync.run,
      context,
    };
    if (hasHelpFlag(argv)) {
      return result(0, renderFiniteStateHelp(argv));
    }
    try {
      const parsed = parseFiniteStateArgv(argv);
      const outcome = await executeCommand(parsed, services);
      const stderr = outcome.stderr ?? "";
      if (
        outcome.exitCode === 2 &&
        stderr.includes("unknown option") &&
        !stderr.includes("Usage:")
      ) {
        return {
          ...outcome,
          stderr: `${stderr.trimEnd()}\n${finiteStateUsage(argv)}\n`,
        };
      }
      return outcome;
    } catch (error: unknown) {
      if (error instanceof CliUsageError) {
        return failUsage(`${error.message}\n${finiteStateUsage(argv)}`);
      }
      throw error;
    }
  };
}

export function registerFiniteStateCli(
  bb: BbPluginApi,
  ctx: PluginContext,
): void {
  const dispatcher = createDispatcher(bb, ctx);
  const slot = ctx.service<AgenticCliSlot>(AGENTIC_CLI_SLOT, () => ({
    run: null,
  }));
  slot.run = dispatcher;
  try {
    bb.cli.register({
      name: FINITE_STATE_COMMAND.name,
      summary: FINITE_STATE_COMMAND.summary,
      commands: withContributedSubtrees(),
      run: dispatcher,
    });
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("already registered")
    ) {
      throw error;
    }
  }
}
