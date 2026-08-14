import type { Node, NodeProps } from "@xyflow/react";

export interface SvgSheetNodeData extends Record<string, unknown> {
  svgMarkup: string;
  title: string;
  overlay?: React.ReactNode;
}

export type SvgSheetFlowNode = Node<SvgSheetNodeData, "svgSheet">;

export function SvgSheetNode({
  data,
}: NodeProps<SvgSheetFlowNode>): React.JSX.Element {
  return (
    <article
      aria-label={`Schematic sheet ${data.title}`}
      className="relative overflow-hidden rounded-sm border border-border bg-background shadow-sm"
    >
      <div
        className="pointer-events-none [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: data.svgMarkup }}
      />
      {data.overlay ? (
        <div className="absolute inset-0">{data.overlay}</div>
      ) : null}
    </article>
  );
}
