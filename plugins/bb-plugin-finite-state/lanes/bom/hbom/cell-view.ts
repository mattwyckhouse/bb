import type { DocumentSourceRef } from "../../../shared/contract.js";
import {
  HBOM_PART_FIELDS,
  type HbomCellState,
  type HbomPartField,
} from "./types.js";

export type ConfidenceBand =
  | "verified"
  | "high"
  | "medium"
  | "low"
  | "conflict"
  | "unknown"
  | "not_applicable";

/** Review queue reasons shown in the UI. */
export type ReviewReason =
  | "proposal"
  | "low_confidence"
  | "conflict"
  | "incomplete_source"
  | "withdrawn_source";

export interface HbomCellView {
  partId: string;
  field: string;
  value: unknown;
  state: HbomCellState;
  confidence: number | null;
  sourceRef: DocumentSourceRef | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  candidateCount: number;
}

export function isHbomPartField(field: string): field is HbomPartField {
  for (const known of HBOM_PART_FIELDS) {
    if (known === field) return true;
  }
  return false;
}

export function reviewCellId(partId: string, field: string): string {
  return `${partId}:${field}`;
}

export function parseReviewCellId(
  id: string,
): { partId: string; field: HbomPartField } | null {
  const split = id.indexOf(":");
  if (split <= 0) return null;
  const partId = id.slice(0, split);
  const field = id.slice(split + 1);
  if (!isHbomPartField(field)) return null;
  return { partId, field };
}

export function confidenceBand(
  state: HbomCellState,
  confidence: number | null,
): ConfidenceBand {
  if (state === "verified") return "verified";
  if (state === "conflict") return "conflict";
  if (state === "unknown") return "unknown";
  if (state === "not_applicable") return "not_applicable";
  if (confidence === null) return "low";
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}
