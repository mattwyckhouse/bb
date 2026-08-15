import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ReactFlowProvider,
  useEdges,
  useNodes,
  useOnSelectionChange,
  useReactFlow,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import type { CanvasFlowNodeData } from "../foundation/CanvasViewport.js";
import type { CanvasModel, CanvasNodeModel } from "../foundation/types.js";
import { AssetNode } from "./AssetNode.js";
import { ComponentNode } from "./ComponentNode.js";
import { ContextMenu } from "./ContextMenu.js";
import { DataflowEdge } from "./DataflowEdge.js";
import { Inspector } from "./Inspector.js";
import { Stencil } from "./Stencil.js";
import { ZoneNode } from "./ZoneNode.js";
import type {
  ArchitectureAdjacency,
  ArchitectureEdgeData,
  ArchitectureModel,
  ArchitectureNodeData,
  CanvasArchitectureGraph,
} from "./adapters.js";
import {
  ArchitectureSelectionContext,
  type ArchitectureContextMenuState,
  type ArchitectureSelectionContextValue,
  type ArchitectureSelectionKind,
  useArchitectureSelection,
} from "./selection.js";

interface RichCanvasNodeModel extends CanvasNodeModel {
  architecture: ArchitectureNodeData;
}

interface CoordinatedCanvasNodeData extends CanvasFlowNodeData {
  architecture?: ArchitectureNodeData;
}

interface CoordinatedCanvasEdgeData extends Record<string, unknown> {
  architecture?: ArchitectureEdgeData;
}

type CoordinatedCanvasNode = Node<CoordinatedCanvasNodeData>;
type CoordinatedCanvasEdge = Edge<CoordinatedCanvasEdgeData>;

function hasUnresolvedZoneReference(node: Node<ArchitectureNodeData>): boolean {
  return Boolean(
    node.data.unresolvedRefs?.some((reference) => reference.field === "zone"),
  );
}

export function CanvasCoordinator(): null {
  const selection = useArchitectureSelection();
  const { fitView, setEdges, setNodes } = useReactFlow<
    CoordinatedCanvasNode,
    CoordinatedCanvasEdge
  >();
  const storedNodeIds = useNodes<CoordinatedCanvasNode>()
    .map((node) => node.id)
    .join("|");
  const storedEdgeIds = useEdges<CoordinatedCanvasEdge>()
    .map((edge) => edge.id)
    .join("|");
  const {
    edgesBySlug,
    focusId,
    graph,
    nodesBySlug,
    onFocusRoute,
    selectedIds,
    setFitSelection,
    setSelectedIds,
  } = selection;

  const synchronizeSelection = useCallback(
    ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const ids = [
        ...nodes.map((node) => node.id),
        ...edges.map((edge) => edge.id),
      ];
      setSelectedIds(ids);
      if (ids.length !== 1) return;
      const selectedId = ids[0];
      if (!selectedId) return;
      onFocusRoute(edgesBySlug.has(selectedId) ? "edge" : "node", selectedId);
    },
    [edgesBySlug, onFocusRoute, setSelectedIds],
  );
  useOnSelectionChange({ onChange: synchronizeSelection });

  useEffect(() => {
    const desiredNodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const desiredEdges = new Map(graph.edges.map((edge) => [edge.id, edge]));
    setNodes((current) =>
      current.map((node) => {
        const desired = desiredNodes.get(node.id);
        if (!desired) return node;
        return {
          ...node,
          type: desired.type,
          parentId: desired.parentId,
          extent: desired.extent,
          expandParent: desired.expandParent,
          position:
            desired.parentId || hasUnresolvedZoneReference(desired)
              ? desired.position
              : node.position,
          style: desired.style,
          data: { ...node.data, architecture: desired.data },
        };
      }),
    );
    setEdges((current) =>
      current.map((edge) => {
        const desired = desiredEdges.get(edge.id);
        return desired
          ? {
              ...edge,
              type: "dataflow",
              data: { ...edge.data, architecture: desired.data },
              markerStart: desired.markerStart,
              markerEnd: desired.markerEnd,
            }
          : edge;
      }),
    );
  }, [
    graph.edges,
    graph.nodes,
    setEdges,
    setNodes,
    storedEdgeIds,
    storedNodeIds,
  ]);

  const fittedGraphKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: node.id === focusId })),
    );
    setEdges((current) =>
      current.map((edge) => ({ ...edge, selected: edge.id === focusId })),
    );
    setSelectedIds([focusId]);
    void fitView({ nodes: [{ id: focusId }], duration: 180, padding: 0.45 });
  }, [fitView, focusId, setEdges, setNodes, setSelectedIds]);

  // Auto-fit once per graph identity so the first paint is not clipped under
  // the inspector rail. Skip when a focus route already drives a targeted fit.
  useEffect(() => {
    if (focusId || !storedNodeIds) return;
    if (fittedGraphKeyRef.current === storedNodeIds) return;
    fittedGraphKeyRef.current = storedNodeIds;
    const frame = requestAnimationFrame(() => {
      void fitView({ duration: 250, padding: 0.2 });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, focusId, storedNodeIds]);

  useEffect(() => {
    setFitSelection(() => {
      // Match React Flow Controls "Fit View": no selection fits the full graph.
      if (selectedIds.length === 0) {
        void fitView({ duration: 180, padding: 0.2 });
        return;
      }
      const nodeIds = selectedIds.flatMap((selectedId) => {
        if (nodesBySlug.has(selectedId)) return [selectedId];
        const edge = edgesBySlug.get(selectedId);
        return edge ? [edge.sourceSlug, edge.targetSlug] : [];
      });
      void fitView({
        nodes: [...new Set(nodeIds)].map((selectedId) => ({ id: selectedId })),
        duration: 180,
        padding: 0.35,
      });
    });
    return () => setFitSelection(null);
  }, [edgesBySlug, fitView, nodesBySlug, selectedIds, setFitSelection]);

  return null;
}

export function toFoundationCanvasModel(
  model: ArchitectureModel,
  graph: CanvasArchitectureGraph,
): CanvasModel {
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const zoneOrder = new Map(
    graph.nodes
      .filter((node) => node.data.kind === "zone")
      .map((node, index) => [node.id, index]),
  );
  const orderedNodes = model.nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftIsZone = left.node.kind === "zone";
      const rightIsZone = right.node.kind === "zone";
      if (leftIsZone !== rightIsZone) return leftIsZone ? -1 : 1;
      if (leftIsZone && rightIsZone) {
        return (
          (zoneOrder.get(left.node.slug) ?? left.index) -
          (zoneOrder.get(right.node.slug) ?? right.index)
        );
      }
      return left.index - right.index;
    });
  const nodes: RichCanvasNodeModel[] = orderedNodes.flatMap(({ node }) => {
    const graphNode = graphNodes.get(node.slug);
    if (!graphNode) return [];
    const isZone = node.kind === "zone";
    return [
      {
        id: node.slug,
        kind: node.kind,
        label: node.name,
        width: graphNode?.width ?? (isZone ? 584 : 216),
        height: graphNode?.height ?? (isZone ? 356 : 112),
        componentType: node.componentType ?? null,
        criticality: node.criticality ?? null,
        isEntryPoint: node.isEntryPoint ?? false,
        architecture: graphNode.data,
      },
    ];
  });
  return {
    nodes,
    edges: graph.edges.flatMap((edge) =>
      edge.data
        ? [
            {
              id: edge.id,
              source: edge.source,
              target: edge.target,
              label: edge.data.name ?? edge.data.slug,
              protocol: edge.data.protocol ?? null,
              encrypted: edge.data.encrypted,
              authenticated: edge.data.authenticated,
              architecture: edge.data,
            },
          ]
        : [],
    ),
    cache: model.cache,
  };
}

export async function loadProductSecurityNodeTypes(): Promise<NodeTypes> {
  return {
    component: ComponentNode,
    zone: ZoneNode,
    asset: AssetNode,
  };
}

export const productSecurityNodeEdgeTypes: EdgeTypes = {
  dataflow: DataflowEdge,
};

export interface ProductSecurityCanvasWorkspaceProps {
  model: ArchitectureModel;
  graph: CanvasArchitectureGraph;
  adjacency: ReadonlyMap<string, ArchitectureAdjacency>;
  focusId: string | null;
  onFocusRoute(kind: ArchitectureSelectionKind, slug: string): void;
  onRepairSourceFile(sourceFile: string, slug: string): void;
  children: ReactNode;
  /**
   * Directive / in-message mode (WP-61). Default false — panel behavior
   * unchanged. When true: no stencil, inspector, or context menu, and menus
   * cannot open. Pair with `maxHeight` and a `React.lazy` import in the
   * directive wrapper.
   */
  readOnly?: boolean;
  /** Optional height clamp in CSS pixels for message-surface embedding. */
  maxHeight?: number;
}

export function ProductSecurityCanvasWorkspace({
  model,
  graph,
  adjacency,
  focusId,
  onFocusRoute,
  onRepairSourceFile,
  children,
  readOnly = false,
  maxHeight,
}: ProductSecurityCanvasWorkspaceProps): React.JSX.Element {
  const [selectedIds, setSelectedIdsState] = useState<readonly string[]>(
    focusId ? [focusId] : [],
  );
  const [menu, setMenu] = useState<ArchitectureContextMenuState | null>(null);
  const fitSelectionRef = useRef<(() => void) | null>(null);
  const setSelectedIds = useCallback((ids: readonly string[]) => {
    setSelectedIdsState([...new Set(ids)]);
  }, []);
  const setFitSelection = useCallback((callback: (() => void) | null) => {
    fitSelectionRef.current = callback;
  }, []);
  const fitSelection = useCallback(() => fitSelectionRef.current?.(), []);
  const openMenu = useCallback(
    (nextMenu: ArchitectureContextMenuState) => {
      if (readOnly) return;
      setMenu(nextMenu);
    },
    [readOnly],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const nodesBySlug = useMemo(
    () => new Map(model.nodes.map((node) => [node.slug, node])),
    [model],
  );
  const edgesBySlug = useMemo(
    () => new Map(model.dataflows.map((edge) => [edge.slug, edge])),
    [model],
  );
  const context = useMemo<ArchitectureSelectionContextValue>(
    () => ({
      graph,
      nodesBySlug,
      edgesBySlug,
      adjacency,
      unresolved: graph.unresolved,
      selectedIds,
      focusId,
      menu: readOnly ? null : menu,
      setSelectedIds,
      setFitSelection,
      fitSelection,
      openMenu,
      closeMenu,
      onFocusRoute,
      onRepairSourceFile,
    }),
    [
      adjacency,
      closeMenu,
      edgesBySlug,
      fitSelection,
      focusId,
      graph,
      menu,
      nodesBySlug,
      onFocusRoute,
      onRepairSourceFile,
      openMenu,
      readOnly,
      selectedIds,
      setFitSelection,
      setSelectedIds,
    ],
  );
  const shellStyle =
    maxHeight === undefined
      ? undefined
      : {
          maxHeight,
          height: maxHeight,
          overflow: "hidden" as const,
        };
  return (
    <ArchitectureSelectionContext.Provider value={context}>
      <div
        className="flex h-full min-h-0 bg-background text-foreground"
        data-canvas-mode={readOnly ? "directive" : "panel"}
        onClick={closeMenu}
        style={shellStyle}
      >
        {readOnly ? null : <Stencil />}
        <div className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            {children}
            <CanvasCoordinator />
          </ReactFlowProvider>
        </div>
        {readOnly ? null : (
          <>
            <Inspector />
            <ContextMenu />
          </>
        )}
      </div>
    </ArchitectureSelectionContext.Provider>
  );
}
