import type { EntityKind } from "../../lib/sync/registry.js";
import type { Json, RemoteService } from "../../lib/remote/types.js";

export interface PullOutcomeReason {
  code: string;
  count: number;
}

export interface PullOutcomeCounts {
  fetched: number;
  baseRows: number;
  quarantined: number;
}

export type PublishedPullOutcome = PullOutcomeCounts & {
  status: "published";
  generationId: string;
  acceptedAt: string;
  reasons: PullOutcomeReason[];
};

export type FailedPullOutcome = PullOutcomeCounts & {
  status: "failed";
  generationId: string | null;
  acceptedAt: null;
  reasons: PullOutcomeReason[];
};

/** Contract-v10 vocabulary shared by engine, CLI, RPC, and Sync UI consumers. */
export type PullKindOutcome = PublishedPullOutcome | FailedPullOutcome;

export interface PullRemoteDiagnostic {
  code: string;
  service: RemoteService;
  method: string | null;
  route: string | null;
  phase: string | null;
  status: number | null;
  retryable: boolean;
  body: Json | null;
}

export interface IsolatedPullReport {
  kinds: Record<string, PullKindOutcome>;
  workingFastForwarded: boolean;
  divergence: string[];
}

export interface PullExecutionReport extends IsolatedPullReport {
  /** CLI-only detail; the frozen syncPull RPC deliberately omits this field. */
  remoteDiagnostics: Record<string, PullRemoteDiagnostic>;
}

export function pullFailureCode(message: string): string {
  return /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(message)?.[1] ?? "PULL_KIND_FAILED";
}

export function aggregatePullReasons(
  reasons: readonly Readonly<{ code: string; count: number }>[],
): PullOutcomeReason[] {
  const totals = new Map<string, number>();
  for (const reason of reasons) {
    if (reason.code.length === 0 || reason.count <= 0) continue;
    totals.set(reason.code, (totals.get(reason.code) ?? 0) + reason.count);
  }
  return [...totals]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

export function selectedOutcome(
  report: IsolatedPullReport,
  kind: EntityKind,
): PullKindOutcome {
  const outcome = report.kinds[kind];
  if (outcome === undefined) {
    throw new Error(`Pull report omitted requested kind ${kind}`);
  }
  return outcome;
}

export function pullReportHasFailures(report: IsolatedPullReport): boolean {
  return Object.values(report.kinds).some(
    (outcome) => outcome.status === "failed",
  );
}

export function renderPullOutcomeCli(report: PullExecutionReport): string {
  const outcomes = Object.entries(report.kinds).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const published = outcomes.filter(
    ([, outcome]) => outcome.status === "published",
  ).length;
  const failed = outcomes.length - published;
  const lines = [
    `Pull complete: ${published} published, ${failed} failed`,
    ...outcomes.flatMap(([kind, outcome]) => {
      const counts = `${outcome.fetched} fetched, ${outcome.baseRows} base rows, ${outcome.quarantined} quarantined`;
      const reasons = outcome.reasons
        .map((reason) => `${reason.code}=${reason.count}`)
        .join(", ");
      const summary = `${kind}: ${outcome.status} · ${counts}${reasons.length > 0 ? ` · ${reasons}` : ""}`;
      const diagnostic = report.remoteDiagnostics[kind];
      if (diagnostic === undefined) return [summary];
      const request = [
        diagnostic.method,
        diagnostic.route,
        diagnostic.status === null ? null : `HTTP ${diagnostic.status}`,
      ]
        .filter((value): value is string => value !== null)
        .join(" ");
      const body =
        diagnostic.body === null
          ? ""
          : ` body=${JSON.stringify(diagnostic.body)}`;
      return [
        summary,
        `  ${diagnostic.code}: ${diagnostic.service}${request.length > 0 ? ` ${request}` : ""}${body}`,
      ];
    }),
  ];
  return `${lines.join("\n")}\n`;
}
