import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  type ComponentType,
} from "react";
import {
  useBbNavigate,
  type PluginMessageDirectiveProps,
} from "@bb/plugin-sdk/app";
import type { CanvasLayoutStorage } from "../../product-security/canvas/foundation/layout-storage.js";
import { useArchitectureData } from "../../product-security/canvas/nodes/useNodeData.js";
import { useResolvedTaraScope } from "../../product-security/canvas/scope/index.js";
import { ThreatOverlayVisibilityProvider } from "../../product-security/canvas/threat-overlay/visibility.js";
import {
  canvasDirectiveSubPath,
  parseDirectiveAttributes,
} from "./attributes.js";
import {
  DirectiveBoundary,
  DirectiveEmptyState,
  DirectiveErrorState,
  DirectiveInvalidAttributes,
  DirectiveLoadingState,
  DirectiveShell,
  DirectiveUnconfiguredState,
} from "./DirectiveBoundary.js";
import { useDirectiveProjectId } from "./project-id.js";

/** Ephemeral layout store — never writes browser or YAML layout from messages. */
const ephemeralLayoutStorage: CanvasLayoutStorage = {
  read() {
    return null;
  },
  write() {
    // Intentionally no-op: message surfaces must not persist canvas layout.
  },
};

function NoopEditingLayer(): null {
  return null;
}

interface LazyCanvasProps {
  focusId: string | null;
  height: number;
  scope: {
    workspaceProjectId: string;
    platformProjectId: string;
    projectVersionId: string | null;
  };
  model: NonNullable<ReturnType<typeof useArchitectureData>["model"]>;
  graph: NonNullable<ReturnType<typeof useArchitectureData>["graph"]>;
  adjacency: NonNullable<ReturnType<typeof useArchitectureData>["adjacency"]>;
  onFocusRoute: (kind: "node" | "edge", slug: string) => void;
}

const LazyReadOnlyCanvas = lazy(async () => {
  const [nodeModule, foundationModule, linksModule, threatModule] =
    await Promise.all([
      import("../../product-security/canvas/nodes/index.js"),
      import("../../product-security/canvas/foundation/CanvasShell.js"),
      import("../../product-security/canvas/links/index.js"),
      import("../../product-security/canvas/threat-overlay/index.js"),
    ]);
  const nodeTypes = await nodeModule.loadProductSecurityNodeTypes();
  const CanvasShell = foundationModule.default;

  function ReadOnlyCanvas(props: LazyCanvasProps): React.JSX.Element {
    const foundationModel = nodeModule.toFoundationCanvasModel(
      props.model,
      props.graph,
    );
    return (
      <nodeModule.ProductSecurityCanvasWorkspace
        adjacency={props.adjacency}
        focusId={props.focusId}
        graph={props.graph}
        maxHeight={props.height}
        model={props.model}
        onFocusRoute={props.onFocusRoute}
        onRepairSourceFile={() => {
          // Read-only message surface: repairs stay in the product-security panel.
        }}
        readOnly
      >
        <CanvasShell
          features={{
            nodeTypes,
            edgeTypes: {
              ...linksModule.productSecurityEdgeTypes,
              ...nodeModule.productSecurityNodeEdgeTypes,
            },
            ThreatOverlay: threatModule.ProductSecurityThreatOverlay,
            LinksLayer: linksModule.ProductSecurityLinksLayer,
            EditingLayer: NoopEditingLayer as ComponentType,
          }}
          layoutStorage={ephemeralLayoutStorage}
          model={foundationModel}
          projectId={`${props.scope.platformProjectId}:${props.scope.projectVersionId ?? "local"}`}
          scope={{
            workspaceProjectId: props.scope.workspaceProjectId,
            platformProjectId: props.scope.platformProjectId,
            projectVersionId: props.scope.projectVersionId,
            mode: props.scope.projectVersionId ? "version" : "local",
          }}
        />
      </nodeModule.ProductSecurityCanvasWorkspace>
    );
  }

  return { default: ReadOnlyCanvas };
});

/**
 * Bounded composition of owner canvas hooks + lazy `ProductSecurityCanvasWorkspace`
 * in FS-229 directive mode (`readOnly` + `maxHeight`).
 */
export function CanvasDirective(
  props: PluginMessageDirectiveProps,
): React.JSX.Element {
  const navigate = useBbNavigate();
  const projectId = useDirectiveProjectId(props.message);
  const parsed = parseDirectiveAttributes("fs-canvas", props.attributes);
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
        detail="Select a bb project so the live TARA canvas can load from the accepted cache."
        title="Choose a project"
      />
    );
  }

  return (
    <DirectiveBoundary source={props.source}>
      <DirectiveShell
        onOpen={() =>
          navigate.toPluginPanel("product-security", {
            subPath: canvasDirectiveSubPath(parsed.value),
          })
        }
        openLabel="Open in Product Security"
      >
        <ThreatOverlayVisibilityProvider>
          <CanvasDirectiveBody
            focus={parsed.value.focus}
            height={parsed.value.height}
            projectId={projectId}
          />
        </ThreatOverlayVisibilityProvider>
      </DirectiveShell>
    </DirectiveBoundary>
  );
}

function CanvasDirectiveBody({
  projectId,
  focus,
  height,
}: {
  projectId: string;
  focus: string | undefined;
  height: number;
}): React.JSX.Element {
  const navigate = useBbNavigate();
  const scopeState = useResolvedTaraScope(projectId);
  const data = useArchitectureData(scopeState.scope);
  const focusId = focus ?? null;
  const onFocusRoute = useCallback(
    (kind: "node" | "edge", slug: string) => {
      navigate.toPluginPanel("product-security", {
        subPath: canvasDirectiveSubPath({
          focus: kind === "node" ? slug : undefined,
        }),
      });
    },
    [navigate],
  );

  const ready =
    scopeState.status === "ready" &&
    scopeState.scope &&
    data.status === "ready" &&
    data.model &&
    data.graph &&
    data.adjacency;

  const emptyModel = useMemo(
    () => ready && data.model !== null && data.model.nodes.length === 0,
    [data.model, ready],
  );

  if (scopeState.status === "unconfigured") {
    return (
      <DirectiveUnconfiguredState
        detail="Associate a Platform project so the TARA canvas can resolve an accepted version."
        title="TARA scope unavailable"
      />
    );
  }
  if (scopeState.status === "loading" || data.status === "loading") {
    return <DirectiveLoadingState label="Loading architecture canvas" />;
  }
  if (scopeState.status === "error") {
    return (
      <DirectiveErrorState
        detail={scopeState.error ?? "TARA scope could not be resolved."}
        onRetry={scopeState.retry}
        title="Canvas unavailable"
      />
    );
  }
  if (data.status === "error" || !ready) {
    return (
      <DirectiveErrorState
        detail={data.error ?? "Architecture model could not be loaded."}
        onRetry={data.retry}
        title="Canvas unavailable"
      />
    );
  }
  if (emptyModel) {
    return (
      <DirectiveEmptyState
        detail="Pull Product Security from Sync so the architecture canvas has nodes to render."
        title="No architecture model yet"
      />
    );
  }

  return (
    <Suspense
      fallback={<DirectiveLoadingState label="Loading architecture canvas" />}
    >
      <LazyReadOnlyCanvas
        adjacency={data.adjacency!}
        focusId={focusId}
        graph={data.graph!}
        height={height}
        model={data.model!}
        onFocusRoute={onFocusRoute}
        scope={scopeState.scope!}
      />
    </Suspense>
  );
}
