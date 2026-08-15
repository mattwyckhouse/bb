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
import type { JsonValue, rpcContract } from "../../../../shared/contract.js";
import { threatFocusSubPath } from "./selection.js";

export interface ThreatCardProps {
  /** Threat slug (untrusted directive attribute). */
  id: string;
  projectVersionId?: string | null;
}

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type CardState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      slug: string;
      name: string;
      category: string | null;
      severity: string | null;
      description: string | null;
      targets: string[];
      mitigations: string[];
    };

function stringField(
  fields: Record<string, JsonValue>,
  key: string,
): string | null {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(fields: Record<string, JsonValue>, key: string): string[] {
  const value = fields[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function severityVariant(
  severity: string | null,
): "destructive" | "secondary" | "outline" {
  if (severity === "critical" || severity === "high") return "destructive";
  if (severity === "medium") return "secondary";
  return "outline";
}

export function ThreatCard({
  id,
  projectVersionId = null,
}: ThreatCardProps): React.JSX.Element {
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CardState>(() => {
    if (!projectId) {
      return {
        kind: "unconfigured",
        message: "Select the bb project that owns this threat model.",
      };
    }
    if (!SAFE_SLUG.test(id)) {
      return {
        kind: "invalid",
        message: "The threat slug is invalid. No request was sent.",
      };
    }
    return { kind: "loading" };
  });

  const load = useCallback(async () => {
    if (!projectId || !SAFE_SLUG.test(id)) return;
    setState({ kind: "loading" });
    try {
      const result = await rpc.call("taraGet", {
        projectId,
        projectVersionId,
        kind: "threat",
        id,
      });
      const name = stringField(result.fields, "name") ?? result.label;
      const category =
        stringField(result.fields, "category") ??
        stringField(result.fields, "rawCategory");
      const severity = stringField(result.fields, "severity");
      const description = stringField(result.fields, "description");
      const targets = [
        ...stringList(result.fields, "affected_components"),
        ...stringList(result.fields, "affected_assets"),
        ...stringList(result.fields, "targetSlugs"),
      ];
      const mitigations = stringList(result.fields, "mitigations");
      setState({
        kind: "ready",
        slug: result.key,
        name,
        category,
        severity,
        description,
        targets: [...new Set(targets)],
        mitigations,
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "The threat could not be loaded.";
      setState({
        kind: /NOT_FOUND/u.test(message) ? "empty" : "error",
        message,
      });
    }
  }, [id, projectId, projectVersionId, rpc]);

  useEffect(() => {
    void load();
  }, [load, revision]);
  useRealtime("tara:changed", () => setRevision((value) => value + 1));

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading threat card"
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        role="status"
      >
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
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
          name="FileQuestion"
        />
        <h3 className="mt-2 text-sm font-semibold">
          {state.kind === "unconfigured"
            ? "Threat unconfigured"
            : state.kind === "invalid"
              ? "Invalid threat identity"
              : "Threat not found"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-destructive">
          Threat unavailable
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

  return (
    <section
      aria-label={`Threat ${state.slug}`}
      className="rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-muted-foreground">
            {state.slug}
          </p>
          <h3 className="mt-1 truncate text-sm font-semibold">{state.name}</h3>
        </div>
        {state.category ? (
          <Badge variant="outline">{state.category.replaceAll("_", " ")}</Badge>
        ) : null}
        {state.severity ? (
          <Badge variant={severityVariant(state.severity)}>
            {state.severity}
          </Badge>
        ) : null}
      </header>
      {state.description ? (
        <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
          {state.description}
        </p>
      ) : null}
      {state.targets.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Targets
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {state.targets.slice(0, 8).map((target) => (
              <Badge key={target} variant="outline">
                {target}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      {state.mitigations.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Mitigations
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {state.mitigations.slice(0, 6).map((mitigation) => (
              <Badge key={mitigation} variant="secondary">
                {mitigation}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-4">
        <Button
          onClick={() =>
            navigate.toPluginPanel("product-security", {
              subPath: threatFocusSubPath(state.slug),
            })
          }
          size="sm"
          variant="secondary"
        >
          Open threat
        </Button>
      </div>
    </section>
  );
}
