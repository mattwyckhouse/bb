import { z } from "zod";
import type {
  DocumentSourceRef,
  JsonValue,
} from "../../../../shared/contract.js";
import {
  confidenceBand,
  type ConfidenceBand,
  type HbomCellView,
} from "../../hbom/cell-view.js";
import type { HbomCellState } from "../../hbom/types.js";

/** Local brand twin of the frozen capability schema — no contract value import. */
const frontendCapabilitySchema = z
  .string()
  .min(32)
  .max(4096)
  .brand<"HumanApprovalCapability">();

/** Opaque capability placeholder — server fails closed regardless of value. */
export const FRONTEND_CAPABILITY_PLACEHOLDER = frontendCapabilitySchema.parse(
  "frontend-cannot-mint-human-approval-capability",
);

export function formatCellValue(value: unknown, state: HbomCellState): string {
  if (state === "not_applicable") return "n/a";
  if (state === "unknown" || value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function trustLabel(state: HbomCellState, band: ConfidenceBand): string {
  if (state === "verified") return "Verified";
  if (state === "not_applicable") return "Human-confirmed";
  if (state === "unknown") return "Unknown";
  if (state === "conflict") return "Conflict";
  if (band === "low") return "Proposal · low confidence";
  if (band === "medium") return "Proposal · medium confidence";
  return "Proposal";
}

export function cellPresentation(
  view: Pick<HbomCellView, "state" | "confidence">,
): {
  band: ConfidenceBand;
  label: string;
  valueClassName: string;
} {
  const band = confidenceBand(view.state, view.confidence);
  const label = trustLabel(view.state, band);
  if (view.state === "verified" || band === "high") {
    return { band, label, valueClassName: "text-foreground" };
  }
  if (view.state === "conflict") {
    return {
      band,
      label,
      valueClassName: "text-foreground underline decoration-dotted",
    };
  }
  if (view.state === "unknown" || view.state === "not_applicable") {
    return { band, label, valueClassName: "text-muted-foreground" };
  }
  if (band === "medium") {
    return {
      band,
      label,
      valueClassName:
        "text-muted-foreground underline decoration-dashed underline-offset-4",
    };
  }
  return {
    band,
    label,
    valueClassName: "text-muted-foreground/70 italic",
  };
}

export function formatLocator(ref: DocumentSourceRef): string {
  if (ref.locator.kind === "pdf") {
    const bbox =
      ref.locator.bbox === undefined
        ? ""
        : ` @${ref.locator.bbox.map((n) => n.toFixed(2)).join(",")}`;
    return `p.${ref.locator.page}${bbox}`;
  }
  if (ref.locator.kind === "sheet") {
    return `${ref.locator.sheet}!${ref.locator.cell}`;
  }
  return `L${ref.locator.lineStart}-${ref.locator.lineEnd}`;
}

/** Browser-safe source-ref encoder — avoids importing lanes/documents server modules. */
export function sourceRefSubPath(ref: DocumentSourceRef): string {
  let fragment: string;
  if (ref.locator.kind === "pdf") {
    fragment =
      ref.locator.bbox === undefined
        ? `p${ref.locator.page}`
        : `p${ref.locator.page}@${ref.locator.bbox.join(",")}`;
  } else if (ref.locator.kind === "sheet") {
    fragment = `${ref.locator.sheet}!${ref.locator.cell}`;
  } else {
    fragment = `L${ref.locator.lineStart}-${ref.locator.lineEnd}`;
  }
  return `${ref.documentSha256}/${encodeURIComponent(`docs/${ref.documentSha256}#${fragment}`)}`;
}

export function isFormControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return (
    target.closest('[contenteditable="true"], input, textarea, select') !== null
  );
}

function recordValue(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

/** Structural DocumentSourceRef parse — no zod/contract value import. */
export function parseSourceRef(
  value: JsonValue | undefined,
): DocumentSourceRef | null {
  const record = recordValue(value);
  if (!record) return null;
  const documentSha256 = record.documentSha256;
  const locator = recordValue(record.locator);
  if (
    typeof documentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(documentSha256)
  ) {
    return null;
  }
  if (!locator) return null;
  if (locator.kind === "pdf" && typeof locator.page === "number") {
    const bbox = locator.bbox;
    if (Array.isArray(bbox) && bbox.length === 4) {
      const numbers = bbox.filter(
        (entry): entry is number => typeof entry === "number",
      );
      if (numbers.length === 4) {
        return {
          documentSha256,
          locator: {
            kind: "pdf",
            page: locator.page,
            bbox: [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!],
          },
        };
      }
    }
    return { documentSha256, locator: { kind: "pdf", page: locator.page } };
  }
  if (
    locator.kind === "sheet" &&
    typeof locator.sheet === "string" &&
    typeof locator.cell === "string"
  ) {
    return {
      documentSha256,
      locator: { kind: "sheet", sheet: locator.sheet, cell: locator.cell },
    };
  }
  if (
    locator.kind === "text" &&
    typeof locator.lineStart === "number" &&
    typeof locator.lineEnd === "number"
  ) {
    return {
      documentSha256,
      locator: {
        kind: "text",
        lineStart: locator.lineStart,
        lineEnd: locator.lineEnd,
      },
    };
  }
  return null;
}

export function parseCellState(value: JsonValue | undefined): HbomCellState {
  return value === "verified" ||
    value === "proposal" ||
    value === "conflict" ||
    value === "unknown" ||
    value === "not_applicable"
    ? value
    : "unknown";
}

export const COLUMN_GROUPS = [
  {
    id: "identity",
    label: "Identity",
    fields: [
      "partNumber",
      "mpn",
      "manufacturer",
      "description",
      "category",
    ] as const,
  },
  {
    id: "placement",
    label: "Placement",
    fields: ["quantity", "referenceDesignators"] as const,
  },
  {
    id: "supply",
    label: "Supply",
    fields: ["lifecycleStatus", "supplier", "countryOfOrigin"] as const,
  },
  {
    id: "compliance",
    label: "Compliance / security",
    fields: [
      "complianceFlags",
      "fccCoveredList",
      "cryptoRelevant",
      "securityRelevance",
      "firmwareLink",
    ] as const,
  },
] as const;
