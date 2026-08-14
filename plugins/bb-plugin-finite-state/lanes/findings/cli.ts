import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@bb/plugin-sdk";
import { isAbsolute, relative, resolve } from "node:path";

import type { NamespacedCliRunner } from "../sync/cli.js";
import type { FindingsDriftService } from "./drift/index.js";
import { MAX_VENDOR_VEX_BYTES } from "./drift/vendor/parse.js";

type DriftCliVerb = "drift" | "import-vex" | "orphans";

interface ParsedArgs {
  verb: DriftCliVerb;
  action: "report" | "refresh" | null;
  projectId: string;
  projectVersionId: string;
  cursor: string | null;
  limit: number;
  json: boolean;
  file: string | null;
  vendor: string | null;
  overwrite: boolean;
  dryRun: boolean;
  prune: boolean;
  confirmed: boolean;
  expectedBaseStateSha256: string | null;
  stableKeys: string[];
}

interface WorkspaceExecution {
  hostId: string;
  root: string;
  workspaceProjectId: string;
}

type ScopeAssertion = (input: {
  workspaceProjectId: string;
  platformProjectId: string;
  projectVersionId: string;
}) => void;

function optionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; consumed: number } {
  const current = args[index] ?? "";
  const equals = current.indexOf("=");
  if (equals >= 0) {
    const value = current.slice(equals + 1);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return { value, consumed: 2 };
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  const rawVerb = args.shift();
  if (
    rawVerb !== "drift" &&
    rawVerb !== "import-vex" &&
    rawVerb !== "orphans"
  ) {
    throw new Error(
      "usage: bb finite-state triage <drift|import-vex|orphans> ... --project ID --version ID",
    );
  }
  let action: ParsedArgs["action"] = null;
  let file: string | null = null;
  if (rawVerb === "drift") {
    const candidate = args[0];
    if (candidate === "report" || candidate === "refresh") {
      action = candidate;
      args.shift();
    } else {
      action = "report";
    }
  } else if (rawVerb === "import-vex") {
    const candidate = args[0];
    if (candidate && !candidate.startsWith("--")) {
      file = candidate;
      args.shift();
    }
  }

  let projectId: string | null = null;
  let projectVersionId: string | null = null;
  let cursor: string | null = null;
  let limit = 100;
  let limitSpecified = false;
  let json = false;
  let vendor: string | null = null;
  let overwrite = false;
  let dryRun = false;
  let prune = false;
  let confirmed = false;
  let expectedBaseStateSha256: string | null = null;
  const stableKeys: string[] = [];
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      json = true;
      index += 1;
    } else if (arg === "--overwrite") {
      overwrite = true;
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
      index += 1;
    } else if (arg === "--prune") {
      prune = true;
      index += 1;
    } else if (arg === "--confirm") {
      confirmed = true;
      index += 1;
    } else if (arg === "--project" || arg.startsWith("--project=")) {
      const option = optionValue(args, index, "--project");
      projectId = option.value;
      index += option.consumed;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      const option = optionValue(args, index, "--version");
      projectVersionId = option.value;
      index += option.consumed;
    } else if (arg === "--cursor" || arg.startsWith("--cursor=")) {
      const option = optionValue(args, index, "--cursor");
      cursor = option.value;
      index += option.consumed;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const option = optionValue(args, index, "--limit");
      limit = positiveInteger(option.value, "--limit");
      limitSpecified = true;
      index += option.consumed;
    } else if (arg === "--vendor" || arg.startsWith("--vendor=")) {
      const option = optionValue(args, index, "--vendor");
      vendor = option.value;
      index += option.consumed;
    } else if (
      arg === "--expected-base" ||
      arg.startsWith("--expected-base=")
    ) {
      const option = optionValue(args, index, "--expected-base");
      expectedBaseStateSha256 = option.value;
      index += option.consumed;
    } else if (arg === "--stable-key" || arg.startsWith("--stable-key=")) {
      const option = optionValue(args, index, "--stable-key");
      stableKeys.push(option.value);
      index += option.consumed;
    } else {
      throw new Error(`unknown option or argument ${arg}`);
    }
  }

  if (!projectId || !projectVersionId) {
    throw new Error("--project and --version are required");
  }
  if (rawVerb === "import-vex" && (!file || !vendor)) {
    throw new Error("import-vex requires <file> and --vendor NAME");
  }
  if (rawVerb !== "import-vex" && (overwrite || vendor !== null || file)) {
    throw new Error("--vendor and --overwrite are valid only for import-vex");
  }
  if (rawVerb !== "orphans" && (prune || confirmed || stableKeys.length > 0)) {
    throw new Error(
      "--prune, --confirm, and --stable-key are valid only for orphans",
    );
  }
  if (rawVerb === "orphans" && prune) {
    if (stableKeys.length === 0 || !expectedBaseStateSha256) {
      throw new Error(
        "orphan prune requires --stable-key and --expected-base from a fresh orphan listing",
      );
    }
    if (!dryRun && !confirmed) {
      throw new Error(
        "orphan prune requires --confirm unless --dry-run is set",
      );
    }
    if (dryRun && confirmed) {
      throw new Error("orphan prune --dry-run cannot also use --confirm");
    }
  }
  if (
    rawVerb === "orphans" &&
    !prune &&
    (dryRun ||
      confirmed ||
      stableKeys.length > 0 ||
      expectedBaseStateSha256 !== null)
  ) {
    throw new Error(
      "--dry-run, --confirm, --stable-key, and --expected-base require --prune",
    );
  }
  if (rawVerb === "drift" && dryRun) {
    throw new Error("drift report and refresh do not accept --dry-run");
  }
  if (rawVerb === "drift" && action === "refresh" && cursor !== null) {
    throw new Error("drift refresh does not accept --cursor");
  }
  if (rawVerb !== "drift" && (cursor !== null || limitSpecified)) {
    throw new Error("--cursor and --limit are valid only for drift reports");
  }
  if (rawVerb !== "orphans" && expectedBaseStateSha256 !== null) {
    throw new Error("--expected-base is valid only for orphan prune");
  }
  if (
    expectedBaseStateSha256 &&
    !/^[a-f0-9]{64}$/u.test(expectedBaseStateSha256)
  ) {
    throw new Error("--expected-base must be a lowercase SHA-256 digest");
  }
  return {
    verb: rawVerb,
    action,
    projectId,
    projectVersionId,
    cursor,
    limit,
    json,
    file,
    vendor,
    overwrite,
    dryRun,
    prune,
    confirmed,
    expectedBaseStateSha256,
    stableKeys,
  };
}

async function workspaceExecution(
  bb: BbPluginApi,
  context: PluginCliContext,
): Promise<WorkspaceExecution> {
  if (!context.threadId) {
    throw new Error(
      "FINDINGS_EXECUTION_CONTEXT_REQUIRED: invoke from a bb thread so the workspace and host are known",
    );
  }
  const thread = await bb.sdk.threads.get({ threadId: context.threadId });
  if (
    !thread.environmentId ||
    (context.projectId !== undefined && thread.projectId !== context.projectId)
  ) {
    throw new Error("FINDINGS_EXECUTION_CONTEXT_INVALID");
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (
    environment.projectId !== thread.projectId ||
    !environment.path ||
    !environment.hostId
  ) {
    throw new Error("FINDINGS_EXECUTION_CONTEXT_INVALID");
  }
  return {
    hostId: environment.hostId,
    root: environment.path,
    workspaceProjectId: thread.projectId,
  };
}

function confinedPath(root: string, file: string): string {
  if (isAbsolute(file)) {
    throw new Error("import-vex requires a worktree-relative file path");
  }
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("import-vex file must stay within the current worktree");
  }
  return path;
}

function output(value: unknown, json: boolean): PluginCliResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(value, null, json ? 0 : 2)}\n`,
    stderr: "",
  };
}

export function createFindingsCliRunner(
  bb: BbPluginApi,
  drift: FindingsDriftService,
  assertScope: ScopeAssertion,
): NamespacedCliRunner {
  return async (argv, context) => {
    const input = parseArgs(argv);
    if (input.verb === "drift") {
      if (input.action === "report") {
        return output(
          drift.report({
            projectId: input.projectId,
            pvId: input.projectVersionId,
            cursor: input.cursor,
            limit: input.limit,
          }),
          input.json,
        );
      }
      const execution = await workspaceExecution(bb, context);
      assertScope({
        workspaceProjectId: execution.workspaceProjectId,
        platformProjectId: input.projectId,
        projectVersionId: input.projectVersionId,
      });
      return output(
        drift.refresh({
          root: execution.root,
          projectId: input.projectId,
          pvId: input.projectVersionId,
          limit: input.limit,
        }),
        input.json,
      );
    }
    if (input.verb === "orphans") {
      if (!input.prune) {
        return output(
          drift.orphanState({
            projectId: input.projectId,
            pvId: input.projectVersionId,
          }),
          input.json,
        );
      }
      const execution = await workspaceExecution(bb, context);
      assertScope({
        workspaceProjectId: execution.workspaceProjectId,
        platformProjectId: input.projectId,
        projectVersionId: input.projectVersionId,
      });
      return output(
        await drift.pruneOrphans({
          root: execution.root,
          projectId: input.projectId,
          pvId: input.projectVersionId,
          stableKeys: input.stableKeys,
          dryRun: input.dryRun,
          confirmed: input.confirmed,
          expectedBaseStateSha256: input.expectedBaseStateSha256!,
        }),
        input.json,
      );
    }

    const execution = await workspaceExecution(bb, context);
    assertScope({
      workspaceProjectId: execution.workspaceProjectId,
      platformProjectId: input.projectId,
      projectVersionId: input.projectVersionId,
    });
    const path = confinedPath(execution.root, input.file!);
    const file = await bb.sdk.files.read({
      hostId: execution.hostId,
      path,
      rootPath: execution.root,
    });
    if (file.sizeBytes > MAX_VENDOR_VEX_BYTES) {
      throw new Error(
        `VENDOR_FILE_OVERSIZED: maximum ${MAX_VENDOR_VEX_BYTES} bytes`,
      );
    }
    const bytes =
      file.contentEncoding === "utf8"
        ? Buffer.from(file.content, "utf8")
        : Buffer.from(file.content, "base64");
    return output(
      await drift.importVendorVex({
        root: execution.root,
        projectId: input.projectId,
        pvId: input.projectVersionId,
        file: input.file!,
        bytes,
        vendor: input.vendor!,
        overwrite: input.overwrite,
        dryRun: input.dryRun,
      }),
      input.json,
    );
  };
}
