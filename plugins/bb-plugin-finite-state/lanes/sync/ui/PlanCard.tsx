import { useCallback, useEffect, useState } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { rpcContract } from "../../../shared/contract.js";
import type { SyncPlanPage } from "./PlanRow.js";

export interface PlanCardProps {
  /** Persisted sync plan ULID (`planId`). */
  id: string;
  projectVersionId?: string | null;
}

const PLAN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

type CardState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; plan: SyncPlanPage };

function planContinuation(planId: string): string {
  return `fsp1:${planId}:0`;
}

export function PlanCard({
  id,
  projectVersionId = null,
}: PlanCardProps): React.JSX.Element {
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CardState>(() => {
    if (!projectId) {
      return {
        kind: "unconfigured",
        message: "Select the bb project that owns this sync plan.",
      };
    }
    if (!PLAN_ID.test(id)) {
      return {
        kind: "invalid",
        message: "The plan identifier is invalid. No request was sent.",
      };
    }
    return { kind: "loading" };
  });

  const load = useCallback(async () => {
    if (!projectId || !PLAN_ID.test(id)) return;
    setState({ kind: "loading" });
    try {
      const plan = await rpc.call("syncPlan", {
        projectId,
        projectVersionId,
        pageSize: 50,
        continuation: planContinuation(id),
      });
      if (plan.planId !== id) {
        setState({
          kind: "empty",
          message: "That sync plan is not available in this project scope.",
        });
        return;
      }
      setState({ kind: "ready", plan });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "The sync plan could not be loaded.";
      setState({
        kind: /NOT_FOUND|PLAN_/u.test(message) ? "empty" : "error",
        message,
      });
    }
  }, [id, projectId, projectVersionId, rpc]);

  useEffect(() => {
    void load();
  }, [load, revision]);
  useRealtime("sync:changed", () => setRevision((value) => value + 1));

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading sync plan"
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        role="status"
      >
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (
    state.kind === "unconfigured" ||
    state.kind === "invalid" ||
    state.kind === "empty"
  ) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <Icon
          aria-hidden="true"
          className="size-5 text-muted-foreground"
          name="GitMerge"
        />
        <h3 className="mt-2 text-sm font-semibold">
          {state.kind === "unconfigured"
            ? "Sync plan unconfigured"
            : state.kind === "invalid"
              ? "Invalid plan identity"
              : "Sync plan not found"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-destructive">
          Sync plan unavailable
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        <Button
          className="mt-3"
          onClick={() => setRevision((value) => value + 1)}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  const { plan } = state;
  const { summary, blastRadius } = plan;
  return (
    <section
      aria-label={`Sync plan ${plan.planId}`}
      className="rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sync plan
          </p>
          <p className="mt-1 truncate font-mono text-xs">{plan.planId}</p>
        </div>
        {blastRadius.requiresHumanReview ? (
          <Badge className="border-warning/40 text-warning" variant="outline">
            Needs review
          </Badge>
        ) : null}
        {plan.cache.state === "stale" ? (
          <Badge variant="outline">Stale cache</Badge>
        ) : null}
      </header>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
        <div>
          <dt className="text-muted-foreground">Creates</dt>
          <dd className="font-mono tabular-nums">{summary.creates}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Updates</dt>
          <dd className="font-mono tabular-nums">{summary.updates}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Deletes</dt>
          <dd className="font-mono tabular-nums">{summary.deletes}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Conflicts</dt>
          <dd className="font-mono tabular-nums">{summary.conflicts}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Orphans</dt>
          <dd className="font-mono tabular-nums">{summary.orphans}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Items</dt>
          <dd className="font-mono tabular-nums">
            {plan.total ?? plan.items.length}
          </dd>
        </div>
      </dl>
      {plan.validationErrors.length > 0 ? (
        <p className="mt-3 text-xs text-destructive">
          {plan.validationErrors.length} validation error
          {plan.validationErrors.length === 1 ? "" : "s"}
        </p>
      ) : null}
      <div className="mt-4">
        <Button
          onClick={() =>
            navigate.toPluginPanel("sync", {
              subPath: `plan/${encodeURIComponent(plan.planId)}`,
            })
          }
          size="sm"
          variant="secondary"
        >
          Open in Sync Review
        </Button>
      </div>
    </section>
  );
}
