export class CliUsageError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliConfigError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
  }
}

export type CliExit = 0 | 2 | 3 | 4 | 5;

export type NativeFamily =
  | "connect"
  | "project-list"
  | "project-use"
  | "push"
  | "triage-list"
  | "triage-set"
  | "triage-apply-policy"
  | "tara-show"
  | "req-list"
  | "req-show"
  | "ears-convert"
  | "verify-matrix"
  | "verify-run"
  | "verify-results"
  | "bom-pull"
  | "bom-sbom-list"
  | "bom-sbom-export"
  | "bom-hbom-seed"
  | "bom-hbom-ingest"
  | "bom-hbom-status"
  | "bom-hbom-review"
  | "bom-hbom-accept"
  | "bom-hbom-reject"
  | "bom-hbom-export"
  | "bench-run"
  | "bench-list"
  | "bench-show"
  | "doc-list"
  | "doc-show"
  | "doc-search";

export interface NativeCommand {
  kind: "native";
  family: NativeFamily;
  json: boolean;
  projectId: string | null;
  projectVersionId: string | null;
  projectLevel: boolean;
  cursor: string | null;
  limit: number | null;
  positional: string[];
  flags: Readonly<Record<string, string | boolean>>;
  surface: string | null;
}

export interface LegacyCommand {
  kind: "legacy";
  argv: string[];
}

export type ParsedCommand = NativeCommand | LegacyCommand;

const SYNC_VERBS = new Set(["pull", "status", "plan"]);
const TRIAGE_LEGACY = new Set(["drift", "import-vex", "orphans"]);
const CONNECT_ACTIONS = new Set(["status", "configure"]);

function optionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; consumed: number } {
  const current = args[index] ?? "";
  const equals = current.indexOf("=");
  if (equals >= 0) {
    const value = current.slice(equals + 1);
    if (value.length === 0)
      throw new CliUsageError(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return { value, consumed: 2 };
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${option} requires a positive integer`);
  }
  return parsed;
}

function stripRoot(argv: readonly string[]): string[] {
  return argv[0] === "finite-state" ? argv.slice(1) : [...argv];
}

function rejectYes(arg: string): void {
  if (arg === "--yes" || arg === "--yes=true" || arg.startsWith("--yes=")) {
    throw new CliUsageError(
      "unknown option --yes: the Finite State CLI has no confirmation bypass; human-only mutations stay in the review panel",
    );
  }
}

function collectFlags(args: readonly string[]): {
  json: boolean;
  projectId: string | null;
  projectVersionId: string | null;
  projectLevel: boolean;
  cursor: string | null;
  limit: number | null;
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  let json = false;
  let projectId: string | null = null;
  let projectVersionId: string | null = null;
  let projectLevel = false;
  let cursor: string | null = null;
  let limit: number | null = null;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    rejectYes(arg);
    if (arg === "--json") {
      json = true;
      index += 1;
    } else if (arg === "--project-level") {
      projectLevel = true;
      index += 1;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
      index += 1;
    } else if (arg === "--drifted") {
      flags.drifted = true;
      index += 1;
    } else if (arg === "--unproven") {
      flags.unproven = true;
      index += 1;
    } else if (arg === "--failing") {
      flags.failing = true;
      index += 1;
    } else if (arg === "--extract") {
      flags.extract = true;
      index += 1;
    } else if (arg === "--verified-only") {
      flags.verifiedOnly = true;
      index += 1;
    } else if (arg === "--xlsx") {
      flags.xlsx = true;
      index += 1;
    } else if (arg === "--cdx") {
      flags.cdx = true;
      index += 1;
    } else if (arg === "--include-vex") {
      flags.includeVex = true;
      index += 1;
    } else if (arg === "--no-include-vex") {
      flags.includeVex = false;
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
      index += option.consumed;
    } else if (arg === "--filter" || arg.startsWith("--filter=")) {
      const option = optionValue(args, index, "--filter");
      flags.filter = option.value;
      index += option.consumed;
    } else if (arg === "--status" || arg.startsWith("--status=")) {
      const option = optionValue(args, index, "--status");
      flags.status = option.value;
      index += option.consumed;
    } else if (arg === "--reason" || arg.startsWith("--reason=")) {
      const option = optionValue(args, index, "--reason");
      flags.reason = option.value;
      index += option.consumed;
    } else if (arg === "--evidence" || arg.startsWith("--evidence=")) {
      const option = optionValue(args, index, "--evidence");
      flags.evidence = option.value;
      index += option.consumed;
    } else if (
      arg === "--justification" ||
      arg.startsWith("--justification=")
    ) {
      const option = optionValue(args, index, "--justification");
      flags.justification = option.value;
      index += option.consumed;
    } else if (arg === "--response" || arg.startsWith("--response=")) {
      const option = optionValue(args, index, "--response");
      flags.response = option.value;
      index += option.consumed;
    } else if (arg === "--pin" || arg.startsWith("--pin=")) {
      const option = optionValue(args, index, "--pin");
      flags.pin = option.value;
      index += option.consumed;
    } else if (
      arg === "--expected-hash" ||
      arg.startsWith("--expected-hash=")
    ) {
      const option = optionValue(args, index, "--expected-hash");
      flags.expectedHash = option.value;
      index += option.consumed;
    } else if (arg === "--clause" || arg.startsWith("--clause=")) {
      const option = optionValue(args, index, "--clause");
      flags.clause = option.value;
      index += option.consumed;
    } else if (arg === "--kind" || arg.startsWith("--kind=")) {
      const option = optionValue(args, index, "--kind");
      flags.kind = option.value;
      index += option.consumed;
    } else if (arg === "--reqs" || arg.startsWith("--reqs=")) {
      const option = optionValue(args, index, "--reqs");
      flags.reqs = option.value;
      index += option.consumed;
    } else if (arg === "--tier" || arg.startsWith("--tier=")) {
      const option = optionValue(args, index, "--tier");
      flags.tier = option.value;
      index += option.consumed;
    } else if (arg === "--check" || arg.startsWith("--check=")) {
      const option = optionValue(args, index, "--check");
      flags.check = option.value;
      index += option.consumed;
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const option = optionValue(args, index, "--format");
      flags.format = option.value;
      index += option.consumed;
    } else if (
      arg === "-o" ||
      arg === "--output" ||
      arg.startsWith("--output=")
    ) {
      const option = optionValue(
        args,
        index,
        arg.startsWith("-o") ? "-o" : "--output",
      );
      flags.output = option.value;
      index += option.consumed;
    } else if (arg === "--candidate" || arg.startsWith("--candidate=")) {
      const option = optionValue(args, index, "--candidate");
      flags.candidate = option.value;
      index += option.consumed;
    } else if (arg === "--target" || arg.startsWith("--target=")) {
      const option = optionValue(args, index, "--target");
      flags.target = option.value;
      index += option.consumed;
    } else if (arg === "--pv" || arg.startsWith("--pv=")) {
      const option = optionValue(args, index, "--pv");
      flags.pv = option.value;
      index += option.consumed;
    } else if (arg === "--type" || arg.startsWith("--type=")) {
      const option = optionValue(args, index, "--type");
      flags.type = option.value;
      index += option.consumed;
    } else if (arg === "--requirement" || arg.startsWith("--requirement=")) {
      const option = optionValue(args, index, "--requirement");
      flags.requirement = option.value;
      index += option.consumed;
    } else if (arg.startsWith("--")) {
      throw new CliUsageError(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
      index += 1;
    }
  }
  if (projectLevel && projectVersionId !== null) {
    throw new CliUsageError(
      "--project-level and --version are mutually exclusive",
    );
  }
  return {
    json,
    projectId,
    projectVersionId,
    projectLevel,
    cursor,
    limit,
    flags,
    positionals,
  };
}

function native(
  family: NativeFamily,
  collected: ReturnType<typeof collectFlags>,
  extra?: { positional?: string[]; surface?: string | null },
): NativeCommand {
  return {
    kind: "native",
    family,
    json: collected.json,
    projectId: collected.projectId,
    projectVersionId: collected.projectVersionId,
    projectLevel: collected.projectLevel,
    cursor: collected.cursor,
    limit: collected.limit,
    positional: extra?.positional ?? collected.positionals,
    flags: collected.flags,
    surface: extra?.surface ?? null,
  };
}

function rewriteSyncAlias(
  verb: string,
  surface: string,
  rest: readonly string[],
): LegacyCommand {
  return { kind: "legacy", argv: [verb, surface, ...rest] };
}

export function parseFiniteStateArgv(argv: readonly string[]): ParsedCommand {
  const args = stripRoot(argv);
  const head = args[0];
  if (head === undefined || head === "--help" || head === "-h") {
    throw new CliUsageError(
      "usage: bb finite-state <connect|project|pull|status|plan|push|triage|tara|req|ears|verify|bom|firmware|bench|doc|as-projects|as-project-select> ...",
    );
  }
  rejectYes(head);

  if (
    head === "as-projects" ||
    head === "as-project-select" ||
    SYNC_VERBS.has(head)
  ) {
    for (const arg of args) rejectYes(arg);
    return { kind: "legacy", argv: args };
  }

  if (head === "firmware") {
    for (const arg of args) rejectYes(arg);
    return { kind: "legacy", argv: args };
  }

  if (head === "connect" || head === "connections") {
    const rest = args.slice(1);
    const action = CONNECT_ACTIONS.has(rest[0] ?? "") ? rest[0] : "status";
    const after = CONNECT_ACTIONS.has(rest[0] ?? "") ? rest.slice(1) : rest;
    const collected = collectFlags(after);
    if (collected.positionals.length > 0) {
      throw new CliUsageError(
        `unexpected argument ${collected.positionals[0]}`,
      );
    }
    return native("connect", collected, {
      positional: [action === undefined ? "status" : action],
    });
  }

  if (head === "project") {
    const action = args[1];
    if (action !== "list" && action !== "use") {
      throw new CliUsageError("usage: bb finite-state project list|use <id>");
    }
    const collected = collectFlags(args.slice(2));
    if (action === "list") {
      if (collected.positionals.length > 0) {
        throw new CliUsageError(
          `unexpected argument ${collected.positionals[0]}`,
        );
      }
      return native("project-list", collected);
    }
    const id = collected.positionals[0];
    if (id === undefined || collected.positionals.length !== 1) {
      throw new CliUsageError("project use requires a Platform project id");
    }
    return native("project-use", collected, { positional: [id] });
  }

  if (head === "push") {
    const collected = collectFlags(args.slice(1));
    const surface =
      collected.positionals.length === 0
        ? null
        : (collected.positionals[0] ?? null);
    if (collected.positionals.length > 1) {
      throw new CliUsageError(
        `unexpected argument ${collected.positionals[1]}`,
      );
    }
    return native("push", collected, { surface });
  }

  if (head === "triage") {
    const action = args[1];
    if (action === undefined || action === "--help" || action === "-h") {
      return { kind: "legacy", argv: args };
    }
    if (TRIAGE_LEGACY.has(action)) {
      for (const arg of args) rejectYes(arg);
      return { kind: "legacy", argv: args };
    }
    if (SYNC_VERBS.has(action)) {
      for (const arg of args) rejectYes(arg);
      return rewriteSyncAlias(action, "triage", args.slice(2));
    }
    if (action === "push") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length > 0) {
        throw new CliUsageError(
          `unexpected argument ${collected.positionals[0]}`,
        );
      }
      return native("push", collected, { surface: "triage" });
    }
    if (action === "list") {
      return native("triage-list", collectFlags(args.slice(2)));
    }
    if (action === "set") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("triage set requires a stable key");
      }
      return native("triage-set", collected);
    }
    if (action === "apply-policy") {
      return native("triage-apply-policy", collectFlags(args.slice(2)));
    }
    throw new CliUsageError(
      `unknown triage verb ${action}; expected list|set|apply-policy|drift|import-vex|orphans|pull|status|plan|push`,
    );
  }

  if (head === "tara") {
    if (args[1] !== "show") {
      throw new CliUsageError("usage: bb finite-state tara show <slug>");
    }
    const collected = collectFlags(args.slice(2));
    if (collected.positionals.length !== 1) {
      throw new CliUsageError("tara show requires a slug");
    }
    return native("tara-show", collected);
  }

  if (head === "req") {
    const action = args[1];
    if (action === "list") {
      return native("req-list", collectFlags(args.slice(2)));
    }
    if (action === "show") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("req show requires a REQ-id");
      }
      return native("req-show", collected);
    }
    throw new CliUsageError("usage: bb finite-state req list|show");
  }

  if (head === "ears") {
    if (args[1] !== "convert") {
      throw new CliUsageError("usage: bb finite-state ears convert");
    }
    return native("ears-convert", collectFlags(args.slice(2)));
  }

  if (head === "verify") {
    const action = args[1];
    if (action === "matrix") {
      return native("verify-matrix", collectFlags(args.slice(2)));
    }
    if (action === "run") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("verify run requires a REQ-id");
      }
      return native("verify-run", collected);
    }
    if (action === "results") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("verify results requires a REQ-id");
      }
      return native("verify-results", collected);
    }
    throw new CliUsageError("usage: bb finite-state verify matrix|run|results");
  }

  if (head === "bom") {
    return parseBom(args.slice(1));
  }

  if (head === "bench") {
    const action = args[1];
    if (action === "verdict") {
      for (const arg of args) rejectYes(arg);
      return { kind: "legacy", argv: args };
    }
    if (action === "run") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("bench run requires positional pv_id");
      }
      return native("bench-run", collected);
    }
    if (action === "list") {
      return native("bench-list", collectFlags(args.slice(2)));
    }
    if (action === "show") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("bench show requires a run_id");
      }
      return native("bench-show", collected);
    }
    throw new CliUsageError(
      "usage: bb finite-state bench run|list|show|verdict",
    );
  }

  if (head === "doc") {
    const action = args[1];
    if (action === "list") {
      return native("doc-list", collectFlags(args.slice(2)));
    }
    if (action === "show") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("doc show requires a doc_id");
      }
      return native("doc-show", collected);
    }
    if (action === "search") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length < 1) {
        throw new CliUsageError("doc search requires a query");
      }
      return native("doc-search", collected, {
        positional: collected.positionals,
      });
    }
    throw new CliUsageError("usage: bb finite-state doc list|show|search");
  }

  throw new CliUsageError(`unknown command ${head}`);
}

function parseBom(args: readonly string[]): ParsedCommand {
  const action = args[0];
  if (action === "pull") {
    return native("bom-pull", collectFlags(args.slice(1)), {
      surface: "sbomComponent",
    });
  }
  if (action === "sbom") {
    const sub = args[1];
    if (sub === "list")
      return native("bom-sbom-list", collectFlags(args.slice(2)));
    if (sub === "export") {
      return native("bom-sbom-export", collectFlags(args.slice(2)));
    }
    throw new CliUsageError("usage: bb finite-state bom sbom list|export");
  }
  if (action === "hbom") {
    const sub = args[1];
    if (sub === "seed")
      return native("bom-hbom-seed", collectFlags(args.slice(2)));
    if (sub === "ingest") {
      const collected = collectFlags(args.slice(2));
      if (collected.positionals.length !== 1) {
        throw new CliUsageError("bom hbom ingest requires a file");
      }
      return native("bom-hbom-ingest", collected);
    }
    if (sub === "status") {
      return native("bom-hbom-status", collectFlags(args.slice(2)));
    }
    if (sub === "review") {
      return native("bom-hbom-review", collectFlags(args.slice(2)));
    }
    if (sub === "accept" || sub === "reject") {
      const collected = collectFlags(args.slice(2));
      if (
        collected.positionals.length < 2 ||
        collected.positionals.length > 2
      ) {
        throw new CliUsageError(`bom hbom ${sub} requires <part> <field>`);
      }
      return native(
        sub === "accept" ? "bom-hbom-accept" : "bom-hbom-reject",
        collected,
      );
    }
    if (sub === "export") {
      return native("bom-hbom-export", collectFlags(args.slice(2)));
    }
    throw new CliUsageError(
      "usage: bb finite-state bom hbom seed|ingest|status|review|accept|reject|export",
    );
  }
  throw new CliUsageError("usage: bb finite-state bom pull|sbom|hbom");
}
