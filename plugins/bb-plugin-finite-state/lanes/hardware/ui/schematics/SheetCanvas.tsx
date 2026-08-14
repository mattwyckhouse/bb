import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
// @ts-expect-error The plugin app builder consumes this declared package CSS export.
import "@xyflow/react/dist/style.css";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { SvgSheetNode, type SvgSheetNodeData } from "./SvgSheetNode.js";

export interface SheetCanvasProps {
  projectKey: string;
  sheetPath: string;
  svgUrl: string | null;
  overlay?: React.ReactNode;
}

interface LoadedSvg {
  markup: string;
  width: number;
  height: number;
}

const nodeTypes: NodeTypes = { svgSheet: SvgSheetNode };
const forbiddenSvgElements = "script,foreignObject,iframe,object,embed,link";

export function sanitizeSvg(source: string): LoadedSvg {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    document.querySelector("parsererror") ||
    document.documentElement.tagName.toLowerCase() !== "svg"
  ) {
    throw new Error("The cached artifact is not a valid SVG document.");
  }
  for (const element of document.querySelectorAll(forbiddenSvgElements))
    element.remove();
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name.endsWith(":href")) &&
          value.startsWith("javascript:"))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const svg = document.documentElement;
  const viewBox = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[ ,]+/u)
    .map(Number);
  const width =
    viewBox?.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0
      ? viewBox[2]!
      : 1200;
  const height =
    viewBox?.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0
      ? viewBox[3]!
      : 800;
  return { markup: new XMLSerializer().serializeToString(svg), width, height };
}

function CanvasBody({
  projectKey,
  sheetPath,
  svgUrl,
  overlay,
}: SheetCanvasProps): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadedSvg | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!svgUrl) {
      setLoaded(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoaded(null);
    setError(null);
    void fetch(svgUrl, {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Cached SVG request failed with HTTP ${response.status}.`,
          );
        return sanitizeSvg(await response.text());
      })
      .then(setLoaded)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "The cached SVG could not be loaded.",
        );
      });
    return () => controller.abort();
  }, [revision, svgUrl]);

  const nodes = useMemo<Array<Node<SvgSheetNodeData, "svgSheet">>>(
    () =>
      loaded
        ? [
            {
              id: `${projectKey}:${sheetPath}`,
              type: "svgSheet",
              position: { x: 0, y: 0 },
              data: { svgMarkup: loaded.markup, title: sheetPath, overlay },
              draggable: false,
              selectable: false,
              connectable: false,
              style: { width: loaded.width, height: loaded.height },
            },
          ]
        : [],
    [loaded, overlay, projectKey, sheetPath],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-destructive/40 bg-card p-5">
          <div className="flex items-center gap-2">
            <Icon className="text-destructive" name="AlertTriangle" />
            <h3 className="text-sm font-semibold">
              Schematic export unavailable
            </h3>
          </div>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {error}
          </p>
          <Button
            className="mt-4"
            onClick={() => setRevision((value) => value + 1)}
            size="sm"
            variant="outline"
          >
            <Icon name="ArrowReloadHorizontal" />
            Retry SVG
          </Button>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div
        aria-label="Loading schematic SVG"
        className="m-4 h-[calc(100%-2rem)] animate-pulse rounded-lg border border-border bg-muted/30"
      />
    );
  }
  return (
    <ReactFlow
      aria-label={`Schematic viewport for ${sheetPath}`}
      fitView
      fitViewOptions={{ padding: 0.08 }}
      minZoom={0.05}
      nodes={nodes}
      nodeTypes={nodeTypes}
      nodesConnectable={false}
      nodesDraggable={false}
      nodesFocusable={false}
      panOnDrag
      proOptions={{ hideAttribution: true }}
      zoomOnDoubleClick={false}
    >
      <Background
        color="currentColor"
        gap={24}
        size={1}
        variant={BackgroundVariant.Dots}
      />
      <Controls showInteractive={false} />
      <MiniMap
        className="border border-border bg-card text-muted-foreground"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}

export function SheetCanvas(props: SheetCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasBody {...props} />
    </ReactFlowProvider>
  );
}
