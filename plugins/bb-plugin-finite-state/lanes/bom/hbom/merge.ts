import type { DocumentSourceRef } from "../../../shared/contract.js";
import {
  type HbomCandidate,
  type HbomCell,
  type HbomProvenance,
} from "./types.js";

/**
 * Precedence ranks for merge. Equal numeric rank means datasheet = bom_import =
 * vendor; disagreement at equal rank is a conflict, never a silent overwrite.
 * Unknown provenances sort below inferred so they cannot displace known claims.
 */
export const HBOM_PRECEDENCE_RANK: Readonly<Record<string, number>> = {
  human: 100,
  datasheet: 80,
  bom_import: 80,
  vendor: 80,
  schematic: 60,
  as_component: 40,
  inferred: 20,
};

export type MergeOutcomeKind =
  | "merged"
  | "corroborated"
  | "conflict"
  | "candidate"
  | "unchanged";

export interface MergeOutcome {
  cell: HbomCell<unknown>;
  kind: MergeOutcomeKind;
  queued: boolean;
}

export interface MergeProposalInput {
  value: unknown;
  provenance: Exclude<HbomProvenance, "human">;
  sourceRef: DocumentSourceRef;
  confidence: number;
  by: string;
  at: string;
}

function rankOf(provenance: string | undefined): number {
  if (provenance === undefined) return -1;
  const known = HBOM_PRECEDENCE_RANK[provenance];
  return known === undefined ? 0 : known;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneCandidates(
  candidates: HbomCandidate<unknown>[] | undefined,
): HbomCandidate<unknown>[] {
  if (candidates === undefined) return [];
  return candidates.map((candidate) => ({
    value: candidate.value,
    provenance: candidate.provenance,
    ...(candidate.sourceRef !== undefined
      ? { sourceRef: candidate.sourceRef }
      : {}),
    confidence: candidate.confidence,
    by: candidate.by,
    at: candidate.at,
  }));
}

function nonHumanProvenance(
  provenance: string,
): Exclude<HbomProvenance, "human"> {
  if (provenance === "human" || provenance.trim().length < 1) {
    throw new Error("candidates cannot use human provenance");
  }
  return provenance;
}

function asCandidate(
  value: unknown,
  provenance: string,
  sourceRef: DocumentSourceRef | undefined,
  confidence: number,
  by: string,
  at: string,
): HbomCandidate<unknown> {
  return {
    value,
    provenance: nonHumanProvenance(provenance),
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    confidence,
    by,
    at,
  };
}

function incumbentToCandidate(
  cell: HbomCell<unknown>,
  fallbackAt: string,
): HbomCandidate<unknown> | null {
  if (cell.provenance === undefined || cell.provenance === "human") {
    return null;
  }
  return asCandidate(
    cell.value,
    cell.provenance,
    cell.sourceRef,
    cell.confidence ?? 0,
    cell.by ?? "unknown",
    cell.at ?? fallbackAt,
  );
}

function proposalCell(input: MergeProposalInput): HbomCell<unknown> {
  return {
    value: input.value,
    provenance: input.provenance,
    sourceRef: input.sourceRef,
    confidence: input.confidence,
    by: input.by,
    at: input.at,
  };
}

function appendUniqueCandidate(
  candidates: HbomCandidate<unknown>[],
  next: HbomCandidate<unknown>,
): HbomCandidate<unknown>[] {
  for (const existing of candidates) {
    if (
      valuesEqual(existing.value, next.value) &&
      existing.provenance === next.provenance &&
      JSON.stringify(existing.sourceRef ?? null) ===
        JSON.stringify(next.sourceRef ?? null)
    ) {
      return candidates;
    }
  }
  return [...candidates, next];
}

/**
 * Remove prior claims from the same document (incumbent or candidates) so a
 * re-extraction is idempotent by (document, part, field).
 */
export function stripClaimsFromDocument(
  cell: HbomCell<unknown> | undefined,
  documentSha256: string,
): HbomCell<unknown> {
  if (cell === undefined) return { value: null };

  const candidates = cloneCandidates(cell.candidates).filter((candidate) => {
    return candidate.sourceRef?.documentSha256 !== documentSha256;
  });

  const incumbentFromDoc =
    cell.sourceRef?.documentSha256 === documentSha256 &&
    cell.provenance !== "human" &&
    cell.accepted === undefined;

  if (!incumbentFromDoc) {
    const next: HbomCell<unknown> = {
      value: cell.value,
      ...(cell.provenance !== undefined ? { provenance: cell.provenance } : {}),
      ...(cell.sourceRef !== undefined ? { sourceRef: cell.sourceRef } : {}),
      ...(cell.confidence !== undefined ? { confidence: cell.confidence } : {}),
      ...(cell.by !== undefined ? { by: cell.by } : {}),
      ...(cell.at !== undefined ? { at: cell.at } : {}),
      ...(cell.note !== undefined ? { note: cell.note } : {}),
      ...(cell.accepted !== undefined
        ? { accepted: { ...cell.accepted } }
        : {}),
      ...(candidates.length > 0 ? { candidates } : {}),
    };
    return next;
  }

  // Incumbent was from this document — drop it; retain unrelated candidates.
  if (candidates.length === 0) return { value: null };
  return { value: null, candidates };
}

function isHumanLocked(cell: HbomCell<unknown>): boolean {
  return cell.provenance === "human" || cell.accepted !== undefined;
}

function isEmptyTarget(cell: HbomCell<unknown>): boolean {
  return cell.provenance === undefined && cell.accepted === undefined;
}

/**
 * Apply one validated non-human proposal to a cell under the eight merge rules.
 * Confidence never changes precedence and never grants acceptance.
 */
export function mergeProposalIntoCell(
  existing: HbomCell<unknown> | undefined,
  input: MergeProposalInput,
  reviewThreshold: number,
): MergeOutcome {
  if (input.provenance === "human") {
    throw new Error("extractor proposals cannot set human provenance");
  }

  const stripped = stripClaimsFromDocument(
    existing,
    input.sourceRef.documentSha256,
  );
  const belowThreshold = input.confidence < reviewThreshold;

  if (isHumanLocked(stripped)) {
    const candidates = appendUniqueCandidate(
      cloneCandidates(stripped.candidates),
      asCandidate(
        input.value,
        input.provenance,
        input.sourceRef,
        input.confidence,
        input.by,
        input.at,
      ),
    );
    return {
      cell: { ...stripped, candidates },
      kind: "candidate",
      queued: true,
    };
  }

  if (isEmptyTarget(stripped)) {
    const cell = proposalCell(input);
    if (stripped.candidates !== undefined && stripped.candidates.length > 0) {
      cell.candidates = cloneCandidates(stripped.candidates);
    }
    return {
      cell,
      kind: "merged",
      queued: belowThreshold,
    };
  }

  const newRank = rankOf(input.provenance);
  const oldRank = rankOf(stripped.provenance);

  if (newRank > oldRank) {
    const demoted = incumbentToCandidate(stripped, input.at);
    const candidates = cloneCandidates(stripped.candidates);
    if (demoted !== null) {
      candidates.unshift(demoted);
    }
    const cell = proposalCell(input);
    if (candidates.length > 0) cell.candidates = candidates;
    return {
      cell,
      kind: "merged",
      queued: belowThreshold,
    };
  }

  if (newRank === oldRank) {
    if (valuesEqual(stripped.value, input.value)) {
      const confidence = Math.max(stripped.confidence ?? 0, input.confidence);
      const candidates = appendUniqueCandidate(
        cloneCandidates(stripped.candidates),
        asCandidate(
          input.value,
          input.provenance,
          input.sourceRef,
          input.confidence,
          input.by,
          input.at,
        ),
      );
      const cell: HbomCell<unknown> = {
        value: stripped.value,
        provenance: stripped.provenance,
        ...(stripped.sourceRef !== undefined
          ? { sourceRef: stripped.sourceRef }
          : { sourceRef: input.sourceRef }),
        confidence,
        ...(stripped.by !== undefined ? { by: stripped.by } : { by: input.by }),
        ...(stripped.at !== undefined ? { at: stripped.at } : { at: input.at }),
        ...(stripped.note !== undefined ? { note: stripped.note } : {}),
        candidates,
      };
      return {
        cell,
        kind: "corroborated",
        queued: confidence < reviewThreshold,
      };
    }

    const candidates = appendUniqueCandidate(
      cloneCandidates(stripped.candidates),
      asCandidate(
        input.value,
        input.provenance,
        input.sourceRef,
        input.confidence,
        input.by,
        input.at,
      ),
    );
    return {
      cell: {
        value: stripped.value,
        provenance: stripped.provenance,
        ...(stripped.sourceRef !== undefined
          ? { sourceRef: stripped.sourceRef }
          : {}),
        ...(stripped.confidence !== undefined
          ? { confidence: stripped.confidence }
          : {}),
        ...(stripped.by !== undefined ? { by: stripped.by } : {}),
        ...(stripped.at !== undefined ? { at: stripped.at } : {}),
        ...(stripped.note !== undefined ? { note: stripped.note } : {}),
        candidates,
      },
      kind: "conflict",
      queued: true,
    };
  }

  // Lower precedence → candidate only.
  const candidates = appendUniqueCandidate(
    cloneCandidates(stripped.candidates),
    asCandidate(
      input.value,
      input.provenance,
      input.sourceRef,
      input.confidence,
      input.by,
      input.at,
    ),
  );
  return {
    cell: {
      value: stripped.value,
      provenance: stripped.provenance,
      ...(stripped.sourceRef !== undefined
        ? { sourceRef: stripped.sourceRef }
        : {}),
      ...(stripped.confidence !== undefined
        ? { confidence: stripped.confidence }
        : {}),
      ...(stripped.by !== undefined ? { by: stripped.by } : {}),
      ...(stripped.at !== undefined ? { at: stripped.at } : {}),
      ...(stripped.note !== undefined ? { note: stripped.note } : {}),
      candidates,
    },
    kind: "candidate",
    queued: belowThreshold,
  };
}
