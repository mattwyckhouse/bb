import type {
  PluginCliCommandInfo,
  PluginCliContext,
  PluginCliResult,
} from "@bb/plugin-sdk";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@bb/plugin-sdk";

/** Plugin-context slot used so WP-64 can own dispatch without a second bb.cli.register. */
export const AGENTIC_CLI_SLOT = "agentic.cli.slot";

export interface AgenticCliSlot {
  run:
    | ((
        argv: string[],
        context: PluginCliContext,
      ) => PluginCliResult | Promise<PluginCliResult>)
    | null;
}

export const FINITE_STATE_CLI_NAME = "finite-state" as const;

export const SYNC_REVIEW_ROUTE = "/plugins/finite-state/sync";
export const HBOM_REVIEW_ROUTE = "/plugins/finite-state/bom";

export const CLI_JSON_MAX_BYTES = PLUGIN_CLI_OUTPUT_MAX_BYTES;

const PUSH_SUMMARY =
  "Prepare and inspect a validated sync plan, then hand off to a human in the Sync Review panel. This CLI command does not push upstream and is not an agent tool.";

const HBOM_ACCEPT_SUMMARY =
  "Validate the selected HBOM review cell and print the HBOM review-panel route. This CLI command does not accept or reject the cell; only the human review panel may resolve it.";

export const CANONICAL_COMMANDS: readonly PluginCliCommandInfo[] = [
  {
    name: "connect",
    summary:
      "Verify Platform, Assurance Studio, and optional Forge compute, or print configuration settings. Surfaces controller slot diagnostics when credentials are set but invalid.",
    usage:
      "connect [status|configure] [--json]\nbb finite-state connections status|configure [--json]",
  },
  {
    name: "connections",
    summary:
      "Alias of connect. Verify remote services or print configuration settings; never reports 'not configured' when settings are set.",
    usage: "connections [status|configure] [--json]",
  },
  {
    name: "project",
    summary:
      "List Platform projects or bind the current workspace to a Platform project id.",
    usage:
      "project list [--json] [--cursor CURSOR] [--limit N]\nproject use <platform-project-id> [--json]",
  },
  {
    name: "as-projects",
    summary: "List linked Assurance Studio projects and the current selection",
    usage: "as-projects [--project PLATFORM_PROJECT_ID] [--json]",
  },
  {
    name: "as-project-select",
    summary: "Select the Assurance Studio project for a Platform project",
    usage:
      "as-project-select --as-project ID [--project PLATFORM_PROJECT_ID] [--json]",
  },
  {
    name: "pull",
    summary:
      "Pull each remote kind independently and report every outcome. Canonical verb-first form; surface-scoped aliases exist under triage.",
    usage:
      "pull [triage|product-security|bom|all] [--project PLATFORM_PROJECT_ID] [--version ID] [--json]",
  },
  {
    name: "status",
    summary:
      "Compare working, base, and upstream state. Canonical verb-first form.",
    usage:
      "status [surface] [--project PLATFORM_PROJECT_ID] [--version ID] [--json]",
  },
  {
    name: "plan",
    summary:
      "Validate and render an ordered sync plan without applying it. Canonical verb-first form.",
    usage:
      "plan [surface] [--project PLATFORM_PROJECT_ID] [--version ID] [--json]",
  },
  {
    name: "push",
    summary: PUSH_SUMMARY,
    usage:
      "push [surface] [--project PLATFORM_PROJECT_ID] [--version ID] [--json]\nDoes not push upstream. There is no --yes flag.",
  },
  {
    name: "triage",
    summary:
      "List or set local VEX overlays, apply policy (local YAML), preview or apply vendor VEX without overwrite, prune orphans, or alias the four sync verbs. triage push is the same review-panel handoff as top-level push.",
    usage:
      "triage --help\ntriage list [--filter STATUS] [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]\ntriage set <stableKey> --status STATUS --reason TEXT --evidence TEXT [--justification CODE] [--response CODE] [--pin exact_version|any_version] [--expected-hash SHA256] [--project ID] [--version ID] [--json]\ntriage apply-policy [--dry-run] [--project ID] [--version ID] [--json]\ntriage drift report|refresh --project ID --version ID [--cursor CURSOR] [--limit N] [--json]\ntriage import-vex preview <file> --vendor NAME --project ID --version ID [--json]\ntriage import-vex apply --import-id ID --expected-document-sha256 SHA256 --project ID --version ID [--json]\ntriage orphans list --project ID --version ID [--json]\ntriage orphans prune --stable-key KEY --expected-base SHA256 --project ID --version ID [--json]\ntriage pull|status|plan|push [flags]  (aliases of the top-level sync verbs, scoped to triage)",
  },
  {
    name: "tara",
    summary:
      "Show one product-security TARA entity by slug from the local model.",
    usage:
      "tara show <slug> [--project ID] [--version ID] [--kind threat|component|zone|dataflow|asset] [--json]",
  },
  {
    name: "req",
    summary: "List or show requirements from the local product-security model.",
    usage:
      "req list [--status STATUS] [--clause CLAUSE] [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]\nreq show <REQ-id> [--project ID] [--version ID] [--json]",
  },
  {
    name: "ears",
    summary:
      "Start a local EARS conversion bundle. Review and acceptance remain on the human conversion panel; the CLI does not record human review.",
    usage:
      "ears convert [--reqs REQ-id,...] [--drifted] [--project ID] [--json]",
  },
  {
    name: "verify",
    summary:
      "Read the verification matrix, queue a mapped check, or show cached results. Queued is not passed evidence.",
    usage:
      "verify matrix [--unproven] [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]\nverify run <REQ-id> [--tier static|emulation|hil|manual|hardware] [--check ID] [--json]\nverify results <REQ-id> [--project ID] [--version ID] [--json]",
  },
  {
    name: "bom",
    summary:
      "Pull SBOM cache, list or export SBOMs, and inspect HBOM seed/status/review/export. HBOM accept|reject only hand off to the human review panel and never resolve cells.",
    usage:
      "bom pull [--version ID] [--project ID] [--json]\nbom sbom list [--filter TEXT] [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]\nbom sbom export --format cyclonedx|spdx [--include-vex|--no-include-vex] [-o file] [--version ID] [--json]\nbom hbom seed [--project ID] [--json]\nbom hbom ingest <file> [--kind KIND] [--extract] [--project ID] [--version ID] [--json]\nbom hbom status [--project ID] [--version ID] [--json]\nbom hbom review [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]\nbom hbom accept <part> <field> [--candidate n] [--project ID] [--version ID] [--json]\nbom hbom reject <part> <field> [--candidate n] [--project ID] [--version ID] [--json]\nbom hbom export --xlsx|--cdx [--verified-only] [-o file] [--project ID] [--version ID] [--json]",
  },
  {
    name: "firmware",
    summary: "Materialize and inspect firmware from a bb thread workspace.",
    usage: "firmware <pull|status|hydrate|diff> ...",
  },
  {
    name: "bench",
    summary:
      "Dispatch a cached-firmware bench run, list or show runs, or evaluate the OTA verdict. bench run takes positional pv_id; --target is optional.",
    usage:
      "bench run <pv_id> [--tier tier0|tier1] [--requirement REQ-id] [--target path] [--json]\nbench list [--pv ID] [--tier tier0|tier1] [--failing] [--cursor CURSOR] [--limit N] [--json]\nbench show <run_id> [--json]\nbench verdict <pv-id> [--digest sha256] [--json]",
  },
  {
    name: "doc",
    summary: "List, show, or search ingested documents from the local ledger.",
    usage:
      "doc list [--type KIND] [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]\ndoc show <doc_id> [--project ID] [--version ID] [--json]\ndoc search <query> [--project ID] [--version ID] [--cursor CURSOR] [--limit N] [--json]",
  },
];

export const FINITE_STATE_COMMAND = {
  name: FINITE_STATE_CLI_NAME,
  summary:
    "Work with Finite State findings, product-security models, BOMs, firmware evidence, and reviewable sync plans.",
  commands: CANONICAL_COMMANDS,
} as const;

export function withContributedSubtrees(
  extra: readonly PluginCliCommandInfo[] = [],
): PluginCliCommandInfo[] {
  const seen = new Set<string>();
  const merged: PluginCliCommandInfo[] = [];
  for (const command of [...CANONICAL_COMMANDS, ...extra]) {
    if (seen.has(command.name)) {
      throw new Error(`duplicate finite-state CLI command "${command.name}"`);
    }
    seen.add(command.name);
    merged.push({
      name: command.name,
      summary: command.summary,
      usage: command.usage,
    });
  }
  return merged;
}

export function renderPluginCommandsSkillFromMetadata(
  commands: readonly PluginCliCommandInfo[] = CANONICAL_COMMANDS,
): string {
  const lines = [
    "## bb finite-state — Work with Finite State findings, product-security models, BOMs, firmware evidence, and reviewable sync plans.",
    "",
    "Contributed by plugin `finite-state`. Run `bb finite-state --help` for details;",
    "`bb plugin run finite-state <args...>` is the explicit equivalent.",
    "",
  ];
  for (const command of commands) {
    lines.push(`- \`${command.usage}\` — ${command.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

export { HBOM_ACCEPT_SUMMARY, PUSH_SUMMARY };
