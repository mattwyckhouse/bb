import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseYaml } from "../../sync/serialize/yaml.js";
import {
  mergeProposalIntoCell,
  stripClaimsFromDocument,
  valuesEqual,
} from "./merge.js";
import type { HbomCell } from "./types.js";

const DOC_A = "a".repeat(64);
const DOC_B = "b".repeat(64);
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/merge-matrix.yaml",
);

function ref(doc = DOC_A, page = 1) {
  return {
    documentSha256: doc,
    locator: { kind: "pdf" as const, page },
  };
}

function proposal(
  value: unknown,
  provenance: "datasheet" | "bom_import" | "vendor" | "schematic" | "inferred",
  confidence = 0.9,
  documentSha256 = DOC_A,
) {
  return {
    value,
    provenance,
    sourceRef: ref(documentSha256),
    confidence,
    by: "extractor",
    at: "2026-08-15T00:00:00.000Z",
  };
}

describe("HBOM merge engine", () => {
  it("loads the merge-matrix fixture covering the eight rules", async () => {
    const raw = parseYaml(await readFile(FIXTURE, "utf8"), "merge-matrix.yaml");
    const cases = Reflect.get(raw, "cases");
    expect(Array.isArray(cases)).toBe(true);
    if (!Array.isArray(cases)) return;
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it("rule 2: empty target receives a proposal", () => {
    const outcome = mergeProposalIntoCell(
      { value: null },
      proposal("BCM6755", "datasheet"),
      0.9,
    );
    expect(outcome.kind).toBe("merged");
    expect(outcome.cell.value).toBe("BCM6755");
    expect(outcome.cell.provenance).toBe("datasheet");
  });

  it("rule 3: higher precedence demotes the old claim", () => {
    const existing: HbomCell<string> = {
      value: "OLD",
      provenance: "inferred",
      confidence: 0.4,
      by: "seed",
      at: "2026-08-01T00:00:00.000Z",
    };
    const outcome = mergeProposalIntoCell(
      existing,
      proposal("NEW", "datasheet"),
      0.9,
    );
    expect(outcome.kind).toBe("merged");
    expect(outcome.cell.value).toBe("NEW");
    expect(outcome.cell.candidates?.[0]?.value).toBe("OLD");
    expect(outcome.cell.candidates?.[0]?.provenance).toBe("inferred");
  });

  it("rule 4: equal rank same value corroborates without dropping sources", () => {
    const existing: HbomCell<string> = {
      value: "BCM6755",
      provenance: "datasheet",
      sourceRef: ref(DOC_A, 3),
      confidence: 0.7,
      by: "a",
      at: "2026-08-01T00:00:00.000Z",
    };
    const outcome = mergeProposalIntoCell(
      existing,
      proposal("BCM6755", "bom_import", 0.95, DOC_B),
      0.9,
    );
    expect(outcome.kind).toBe("corroborated");
    expect(outcome.cell.confidence).toBe(0.95);
    expect(outcome.cell.candidates?.length).toBe(1);
    expect(outcome.cell.candidates?.[0]?.sourceRef?.documentSha256).toBe(DOC_B);
  });

  it("rule 5: equal rank different value conflicts", () => {
    const existing: HbomCell<string> = {
      value: "A",
      provenance: "datasheet",
      sourceRef: ref(DOC_A),
      confidence: 0.8,
      by: "a",
      at: "2026-08-01T00:00:00.000Z",
    };
    const outcome = mergeProposalIntoCell(
      existing,
      proposal("B", "vendor", 0.99, DOC_B),
      0.9,
    );
    expect(outcome.kind).toBe("conflict");
    expect(outcome.queued).toBe(true);
    expect(outcome.cell.value).toBe("A");
    expect(outcome.cell.candidates?.[0]?.value).toBe("B");
  });

  it("rule 6: lower precedence becomes a candidate; human cells are immutable", () => {
    const datasheet: HbomCell<string> = {
      value: "A",
      provenance: "datasheet",
      sourceRef: ref(DOC_A),
      confidence: 0.8,
      by: "a",
      at: "2026-08-01T00:00:00.000Z",
    };
    const lower = mergeProposalIntoCell(
      datasheet,
      proposal("B", "schematic", 0.99, DOC_B),
      0.9,
    );
    expect(lower.kind).toBe("candidate");
    expect(lower.cell.value).toBe("A");

    const human: HbomCell<string> = {
      value: "HUMAN",
      provenance: "human",
      confidence: 1,
      by: "reviewer",
      at: "2026-08-01T00:00:00.000Z",
    };
    const againstHuman = mergeProposalIntoCell(
      human,
      proposal("AGENT", "datasheet", 0.99),
      0.9,
    );
    expect(againstHuman.kind).toBe("candidate");
    expect(againstHuman.cell.value).toBe("HUMAN");
    expect(againstHuman.cell.provenance).toBe("human");
  });

  it("rule 7: same document/part/field replaces prior claim idempotently", () => {
    const existing: HbomCell<string> = {
      value: "OLD",
      provenance: "datasheet",
      sourceRef: ref(DOC_A, 2),
      confidence: 0.5,
      by: "extractor",
      at: "2026-08-01T00:00:00.000Z",
    };
    const first = mergeProposalIntoCell(
      existing,
      proposal("NEW", "datasheet", 0.8),
      0.9,
    );
    expect(first.kind).toBe("merged");
    expect(first.cell.value).toBe("NEW");
    const second = mergeProposalIntoCell(
      first.cell,
      proposal("NEW", "datasheet", 0.8),
      0.9,
    );
    expect(second.cell.value).toBe("NEW");
    expect(valuesEqual(first.cell.value, second.cell.value)).toBe(true);
  });

  it("confidence never outranks provenance", () => {
    const existing: HbomCell<string> = {
      value: "A",
      provenance: "datasheet",
      sourceRef: ref(DOC_A),
      confidence: 0.2,
      by: "a",
      at: "2026-08-01T00:00:00.000Z",
    };
    const outcome = mergeProposalIntoCell(
      existing,
      proposal("B", "inferred", 0.99, DOC_B),
      0.9,
    );
    expect(outcome.kind).toBe("candidate");
    expect(outcome.cell.value).toBe("A");
  });

  it("stripClaimsFromDocument never discards unrelated candidates", () => {
    const cell: HbomCell<string> = {
      value: "A",
      provenance: "datasheet",
      sourceRef: ref(DOC_A),
      confidence: 0.8,
      by: "a",
      at: "2026-08-01T00:00:00.000Z",
      candidates: [
        {
          value: "B",
          provenance: "schematic",
          sourceRef: ref(DOC_B),
          confidence: 0.5,
          by: "b",
          at: "2026-08-01T00:00:00.000Z",
        },
      ],
    };
    const stripped = stripClaimsFromDocument(cell, DOC_A);
    expect(stripped.value).toBe(null);
    expect(stripped.candidates?.[0]?.value).toBe("B");
  });
});
