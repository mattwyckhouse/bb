import type { DocumentSourceRef } from "../../../shared/contract.js";

export interface OverlayExtraction {
  id: string;
  field: string;
  value: string;
  confidence: number | null;
  status: string;
  sourceRef: string;
  targetLabel: string | null;
  page: number | null;
  sheet: string | null;
  cell: string | null;
  bbox: string | null;
}

export function ExtractionOverlay(props: {
  extractions: OverlayExtraction[];
  focus: DocumentSourceRef | null;
}): React.JSX.Element | null {
  const focused = props.extractions.filter((item) => {
    if (!props.focus) return item.bbox !== null || item.cell !== null;
    if (props.focus.locator.kind === "pdf") {
      return item.page === props.focus.locator.page && item.bbox !== null;
    }
    if (props.focus.locator.kind === "sheet") {
      return (
        item.sheet === props.focus.locator.sheet &&
        item.cell === props.focus.locator.cell
      );
    }
    return false;
  });

  if (focused.length === 0) return null;

  return (
    <div
      aria-label="Extraction overlays"
      className="pointer-events-none absolute inset-3 overflow-hidden"
    >
      {focused.map((item) => {
        let style: React.CSSProperties = {
          left: "1rem",
          top: "1rem",
          width: "12rem",
        };
        if (item.bbox) {
          try {
            const parsed: unknown = JSON.parse(item.bbox);
            if (
              Array.isArray(parsed) &&
              parsed.length === 4 &&
              parsed.every((value) => typeof value === "number")
            ) {
              const [x0, y0, x1, y1] = parsed;
              style = {
                left: `${x0 * 100}%`,
                top: `${y0 * 100}%`,
                width: `${Math.max(0.01, x1 - x0) * 100}%`,
                height: `${Math.max(0.01, y1 - y0) * 100}%`,
              };
            }
          } catch {
            // Keep fallback label placement when bbox JSON is malformed.
          }
        }
        return (
          <div
            className="absolute rounded-sm border border-primary/70 bg-primary/10 p-1 text-[10px] text-foreground shadow-xs"
            key={item.id}
            style={style}
            title={`${item.field}=${item.value}`}
          >
            <span className="font-medium">{item.field}</span>
            {item.confidence !== null ? (
              <span className="ml-1 opacity-80">
                {item.confidence.toFixed(2)}
              </span>
            ) : null}
            {item.cell ? (
              <span className="ml-1 font-mono opacity-80">{item.cell}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
