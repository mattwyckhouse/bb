import { useEffect, useState, type ComponentType } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRpc,
  type PluginAppBuilder,
  type PluginMessageDirectiveProps,
} from "@bb/plugin-sdk/app";
import type { AppContext } from "../../../lib/app-context.js";
import { bomAppRpcContract } from "../../bom/rpc.js";
import { FindingCard } from "../../findings/ui/detail/FindingCard.js";
import { RequirementCard } from "../../product-security/requirements/cards/RequirementCard.js";
import {
  BomScopeProvider,
  ComponentCard,
} from "../../bom/app/sbom/component-card.js";
import { HbomSummaryCard } from "../../bom/app/hbom/hbom-summary-card.js";
import { BenchRunCard } from "../../bench/app/bench-run-card.js";
import { VerdictCard } from "../../bench/app/verdict-card.js";
import {
  benchRunDirectiveSubPath,
  componentDirectiveSubPath,
  encodeFindingDirectiveKey,
  findingDirectiveSubPath,
  parseDirectiveAttributes,
  PR1_DIRECTIVE_IDS,
  requirementDirectiveSubPath,
  verdictDirectiveSubPath,
  type Pr1DirectiveId,
} from "./attributes.js";
import {
  DirectiveBoundary,
  DirectiveInvalidAttributes,
  DirectiveLoadingState,
  DirectiveShell,
  DirectiveUnconfiguredState,
} from "./DirectiveBoundary.js";

type DirectiveComponent = ComponentType<PluginMessageDirectiveProps>;

function useDirectiveProjectId(
  message: PluginMessageDirectiveProps["message"],
): string | null {
  const { projectId: contextProjectId } = useBbContext();
  return message.projectId ?? contextProjectId;
}

function FindingDirective(
  props: PluginMessageDirectiveProps,
): React.JSX.Element {
  const navigate = useBbNavigate();
  const parsed = parseDirectiveAttributes("fs-finding", props.attributes);
  if (!parsed.ok) {
    return (
      <DirectiveInvalidAttributes
        issues={parsed.issues}
        source={props.source}
      />
    );
  }
  let stableKey: string;
  try {
    stableKey = encodeFindingDirectiveKey(parsed.value);
  } catch (error) {
    return (
      <DirectiveInvalidAttributes
        issues={[
          error instanceof Error
            ? error.message
            : "Finding identity could not be encoded",
        ]}
        source={props.source}
      />
    );
  }
  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() =>
          navigate.toPluginPanel("findings", {
            subPath: findingDirectiveSubPath(stableKey),
          })
        }
        openLabel="Open in Findings"
      >
        <FindingCard compact stableKey={stableKey} />
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

function RequirementDirective(
  props: PluginMessageDirectiveProps,
): React.JSX.Element {
  const navigate = useBbNavigate();
  const projectId = useDirectiveProjectId(props.message);
  const parsed = parseDirectiveAttributes("fs-req", props.attributes);
  if (!parsed.ok) {
    return (
      <DirectiveInvalidAttributes
        issues={parsed.issues}
        source={props.source}
      />
    );
  }
  if (!projectId) {
    return (
      <DirectiveUnconfiguredState
        detail="Select a bb project so the requirement card can self-fetch from the local cache."
        title="Choose a project"
      />
    );
  }
  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() =>
          navigate.toPluginPanel("product-security", {
            subPath: requirementDirectiveSubPath(parsed.value.id),
          })
        }
        openLabel="Open in Product Security"
      >
        <RequirementCard id={parsed.value.id} projectId={projectId} readOnly />
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

function ComponentDirectiveScope({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const rpc = useRpc<typeof bomAppRpcContract>();
  const [scope, setScope] = useState<{
    projectId: string;
    projectVersionId: string;
  } | null>(null);
  const [status, setStatus] = useState<"loading" | "unconfigured" | "ready">(
    "loading",
  );

  useEffect(() => {
    let active = true;
    setStatus("loading");
    void rpc
      .call("bomCachedProjectVersions", { projectId })
      .then((result) => {
        if (!active) return;
        const selected =
          result.versions.find(
            (version) =>
              version.platformProjectId === result.selectedPlatformProjectId &&
              version.projectVersionId === result.selectedProjectVersionId,
          ) ?? result.versions[0];
        if (!selected) {
          setScope(null);
          setStatus("unconfigured");
          return;
        }
        setScope({
          projectId: selected.platformProjectId,
          projectVersionId: selected.projectVersionId,
        });
        setStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setScope(null);
        setStatus("unconfigured");
      });
    return () => {
      active = false;
    };
  }, [projectId, rpc]);

  if (status === "loading") {
    return <DirectiveLoadingState label="Loading BOM scope" />;
  }
  if (status === "unconfigured" || !scope) {
    return (
      <DirectiveUnconfiguredState
        detail="Pull or select a project version so SBOM/HBOM component cards can load from the accepted cache."
        title="BOM scope unavailable"
      />
    );
  }
  return (
    <BomScopeProvider
      projectId={scope.projectId}
      projectVersionId={scope.projectVersionId}
    >
      {children}
    </BomScopeProvider>
  );
}

function ComponentDirective(
  props: PluginMessageDirectiveProps,
): React.JSX.Element {
  const navigate = useBbNavigate();
  const projectId = useDirectiveProjectId(props.message);
  const parsed = parseDirectiveAttributes("fs-component", props.attributes);
  if (!parsed.ok) {
    return (
      <DirectiveInvalidAttributes
        issues={parsed.issues}
        source={props.source}
      />
    );
  }
  if (!projectId) {
    return (
      <DirectiveUnconfiguredState
        detail="Select a bb project so the component card can self-fetch from the BOM cache."
        title="Choose a project"
      />
    );
  }
  const mode = "purl" in parsed.value ? "software" : "hardware";
  const id = "purl" in parsed.value ? parsed.value.purl : parsed.value.part;
  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() =>
          navigate.toPluginPanel("bom", {
            subPath: componentDirectiveSubPath(parsed.value),
          })
        }
        openLabel="Open in Bill of Materials"
      >
        <ComponentDirectiveScope projectId={projectId}>
          <ComponentCard id={id} mode={mode} />
        </ComponentDirectiveScope>
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

function HbomSummaryDirective(
  props: PluginMessageDirectiveProps,
): React.JSX.Element {
  const navigate = useBbNavigate();
  const projectId = useDirectiveProjectId(props.message);
  const parsed = parseDirectiveAttributes("fs-hbom-summary", props.attributes);
  if (!parsed.ok) {
    return (
      <DirectiveInvalidAttributes
        issues={parsed.issues}
        source={props.source}
      />
    );
  }
  if (!projectId) {
    return (
      <DirectiveUnconfiguredState
        detail="Select a bb project so HBOM trust metrics can load. This directive takes no attributes; project scope comes from the message."
        title="Choose a project"
      />
    );
  }
  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() => navigate.toPluginPanel("bom", { subPath: "hardware" })}
        openLabel="Open HBOM"
      >
        <HbomSummaryCard id={projectId} />
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

function BenchDirective(props: PluginMessageDirectiveProps): React.JSX.Element {
  const navigate = useBbNavigate();
  const projectId = useDirectiveProjectId(props.message);
  const parsed = parseDirectiveAttributes("fs-bench", props.attributes);
  if (!parsed.ok) {
    return (
      <DirectiveInvalidAttributes
        issues={parsed.issues}
        source={props.source}
      />
    );
  }
  if (!projectId) {
    return (
      <DirectiveUnconfiguredState
        detail="Select a bb project so the bench run card can self-fetch."
        title="Choose a project"
      />
    );
  }
  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() =>
          navigate.toPluginPanel("bench", {
            subPath: benchRunDirectiveSubPath(parsed.value.id),
          })
        }
        openLabel="Open in Verification Bench"
      >
        <BenchRunCard id={parsed.value.id} />
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

function VerdictDirective(
  props: PluginMessageDirectiveProps,
): React.JSX.Element {
  const navigate = useBbNavigate();
  const projectId = useDirectiveProjectId(props.message);
  const parsed = parseDirectiveAttributes("fs-verdict", props.attributes);
  if (!parsed.ok) {
    return (
      <DirectiveInvalidAttributes
        issues={parsed.issues}
        source={props.source}
      />
    );
  }
  if (!projectId) {
    return (
      <DirectiveUnconfiguredState
        detail="Select a bb project so the OTA verdict card can self-fetch from warm cache."
        title="Choose a project"
      />
    );
  }
  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() =>
          navigate.toPluginPanel("bench", {
            subPath: verdictDirectiveSubPath(parsed.value.id),
          })
        }
        openLabel="Open verdict"
      >
        <VerdictCard id={parsed.value.id} projectId={projectId} />
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

const PR1_COMPONENTS: Readonly<Record<Pr1DirectiveId, DirectiveComponent>> = {
  "fs-finding": FindingDirective,
  "fs-req": RequirementDirective,
  "fs-component": ComponentDirective,
  "fs-hbom-summary": HbomSummaryDirective,
  "fs-bench": BenchDirective,
  "fs-verdict": VerdictDirective,
};

/**
 * Composition-only registrar for WP-61 PR 1. Registers the six card-backed
 * directive ids; FS-229 supplies the remaining six owner cards/modes for PR 2.
 */
export function registerDirectives(
  app: PluginAppBuilder,
  _ctx: AppContext,
): void {
  for (const id of PR1_DIRECTIVE_IDS) {
    app.slots.messageDirective({
      id,
      component: PR1_COMPONENTS[id],
    });
  }
}

export const registeredDirectiveComponents = PR1_COMPONENTS;
