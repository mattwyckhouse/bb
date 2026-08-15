import { Badge } from "@bb/shared-ui/badge";
import { cellPresentation, formatCellValue } from "./hbom-presentation.js";
import type { HbomCellView } from "../../hbom/cell-view.js";

export interface HbomCellProps {
  cell: HbomCellView;
  onOpenProvenance?(): void;
  compact?: boolean;
}

export function HbomCell({
  cell,
  onOpenProvenance,
  compact = false,
}: HbomCellProps): React.JSX.Element {
  const presentation = cellPresentation(cell);
  const display = formatCellValue(cell.value, cell.state);
  const competing =
    cell.state === "conflict" || cell.candidateCount > 0
      ? `${cell.candidateCount} competing claim${cell.candidateCount === 1 ? "" : "s"}`
      : null;

  return (
    <button
      aria-label={`${cell.field}: ${display}. ${presentation.label}${competing ? `. ${competing}` : ""}`}
      className={`group flex max-w-full flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        compact ? "px-1 py-0.5" : "px-1.5 py-1"
      }`}
      onClick={onOpenProvenance}
      type="button"
    >
      <span className={`font-mono text-xs ${presentation.valueClassName}`}>
        {display}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge
          className="h-5 px-1.5 text-[10px] font-medium uppercase tracking-wide"
          variant="outline"
        >
          {presentation.label}
        </Badge>
        {competing ? (
          <span className="text-[10px] text-muted-foreground">{competing}</span>
        ) : null}
        {cell.confidence !== null && cell.state === "proposal" ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {cell.confidence.toFixed(2)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
