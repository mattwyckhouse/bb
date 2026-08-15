import { describe, expect, it } from "vitest";

import {
  assertCellNotScalar,
  deriveHbomCellState,
  HbomValidationError,
  parseHbomDocument,
} from "./schema.js";
import { HBOM_SCHEMA_ID, type HbomDocument } from "./types.js";

const DOC_A = "a".repeat(64);
const DOC_B = "b".repeat(64);
const DOC_UNKNOWN = "c".repeat(64);

function baseDoc(parts: HbomDocument["parts"]): Record<string, unknown> {
  return {
    schema: HBOM_SCHEMA_ID,
    project: "acme-router",
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts,
  };
}

describe("fs-hbom/v1 schema", () => {
  it("accepts a full provenance cell document and rejects scalar shortcuts", () => {
    const document = parseHbomDocument(
      baseDoc([
        {
          id: "HBOM-0001",
          asComponentId: null,
          mpn: {
            value: "BCM6755KFEBG",
            provenance: "bom_import",
            sourceRef: {
              documentSha256: DOC_A,
              locator: { kind: "sheet", sheet: "Sheet1", cell: "A14" },
            },
            confidence: 0.72,
            by: "bb-agent",
            at: "2026-07-29T14:02:11.000Z",
            candidates: [
              {
                value: "BCM6755KFEB",
                provenance: "datasheet",
                sourceRef: {
                  documentSha256: DOC_B,
                  locator: { kind: "pdf", page: 7 },
                },
                confidence: 0.61,
                by: "bb-agent",
                at: "2026-07-29T14:02:11.000Z",
              },
            ],
          },
          supplier: {
            value: "Avnet",
            provenance: "human",
            confidence: 1,
            by: "reviewer-id",
            at: "2026-07-30T09:14:00.000Z",
          },
          countryOfOrigin: { value: null },
        },
      ]),
      { ledger: (sha) => sha === DOC_A || sha === DOC_B },
    );

    expect(document.parts).toHaveLength(1);
    expect(document.parts[0]?.mpn?.value).toBe("BCM6755KFEBG");
    expect(document.parts[0]?.countryOfOrigin).toEqual({ value: null });
    expect(() => assertCellNotScalar("BCM6755", "mpn")).toThrow(
      HbomValidationError,
    );
  });

  it("enforces human confidence 1 with actor and timestamp", () => {
    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0001",
            asComponentId: null,
            supplier: {
              value: "Avnet",
              provenance: "human",
              confidence: 0.9,
              by: "reviewer",
              at: "2026-07-30T09:14:00.000Z",
            },
          },
        ]),
      ),
    ).toThrow(/human provenance requires confidence 1/);

    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0001",
            asComponentId: null,
            supplier: {
              value: "Avnet",
              provenance: "human",
              confidence: 1,
              at: "2026-07-30T09:14:00.000Z",
            },
          },
        ]),
      ),
    ).toThrow(/human provenance requires by/);
  });

  it("requires sourceRef for document-backed provenances and rejects filename-only claims", () => {
    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0001",
            asComponentId: null,
            mpn: {
              value: "X",
              provenance: "datasheet",
              confidence: 0.9,
              by: "agent",
              at: "2026-07-29T14:02:11.000Z",
            },
          },
        ]),
      ),
    ).toThrow(/requires sourceRef/);

    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0001",
            asComponentId: null,
            mpn: {
              value: "X",
              provenance: "bom_import",
              sourceRef: {
                documentSha256: DOC_A,
                locator: { kind: "sheet", sheet: "Sheet1", cell: "14" },
              },
              confidence: 0.9,
              by: "agent",
              at: "2026-07-29T14:02:11.000Z",
            },
          },
        ]),
        { ledger: () => true },
      ),
    ).toThrow(/sourceRef failed DocumentSourceRef validation|Invalid/);
  });

  it("validates PDF page/bbox and sheet/cell; rejects unknown digests and path traversal", () => {
    const ok = parseHbomDocument(
      baseDoc([
        {
          id: "HBOM-0002",
          asComponentId: null,
          manufacturer: {
            value: "Broadcom",
            provenance: "datasheet",
            sourceRef: {
              documentSha256: DOC_A,
              locator: {
                kind: "pdf",
                page: 1,
                bbox: [0.1, 0.2, 0.8, 0.9],
              },
            },
            confidence: 0.95,
            by: "bb-agent",
            at: "2026-07-29T14:02:11.000Z",
          },
        },
      ]),
      { ledger: (sha) => sha === DOC_A },
    );
    expect(ok.parts[0]?.manufacturer?.sourceRef?.locator).toMatchObject({
      kind: "pdf",
      page: 1,
    });

    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0003",
            asComponentId: null,
            manufacturer: {
              value: "Broadcom",
              provenance: "datasheet",
              sourceRef: {
                documentSha256: DOC_UNKNOWN,
                locator: { kind: "pdf", page: 1 },
              },
              confidence: 0.95,
              by: "bb-agent",
              at: "2026-07-29T14:02:11.000Z",
            },
          },
        ]),
        { ledger: (sha) => sha === DOC_A },
      ),
    ).toThrow(/not in the document ledger/);

    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0004",
            asComponentId: null,
            mpn: {
              value: "X",
              provenance: "bom_import",
              sourceRef: {
                documentSha256: DOC_A,
                locator: {
                  kind: "sheet",
                  sheet: "../etc/passwd",
                  cell: "A1",
                },
              },
              confidence: 0.9,
              by: "agent",
              at: "2026-07-29T14:02:11.000Z",
            },
          },
        ]),
        { ledger: () => true },
      ),
    ).toThrow(/path segments/);
  });

  it("rejects duplicate part ids, unknown fields, and invalid dates", () => {
    expect(() =>
      parseHbomDocument(
        baseDoc([
          { id: "HBOM-0001", asComponentId: null },
          { id: "HBOM-0001", asComponentId: null },
        ]),
      ),
    ).toThrow(/duplicate part id/);

    expect(() =>
      parseHbomDocument({
        ...baseDoc([{ id: "HBOM-0001", asComponentId: null }]),
        extra: true,
      }),
    ).toThrow(/unknown field "extra"/);

    expect(() =>
      parseHbomDocument(
        baseDoc([
          {
            id: "HBOM-0001",
            asComponentId: null,
            supplier: {
              value: "Avnet",
              provenance: "human",
              confidence: 1,
              by: "reviewer",
              at: "not-a-date",
            },
          },
        ]),
      ),
    ).toThrow(/Invalid|datetime|ISO/i);
  });

  it("keeps bare null and human null semantically distinct", () => {
    const document = parseHbomDocument(
      baseDoc([
        {
          id: "HBOM-0001",
          asComponentId: null,
          countryOfOrigin: { value: null },
          supplier: {
            value: null,
            provenance: "human",
            confidence: 1,
            by: "reviewer",
            at: "2026-07-30T09:14:00.000Z",
          },
        },
      ]),
    );
    expect(deriveHbomCellState(document.parts[0]?.countryOfOrigin)).toBe(
      "unknown",
    );
    expect(deriveHbomCellState(document.parts[0]?.supplier)).toBe(
      "not_applicable",
    );
  });

  it("never auto-verifies agent cells from confidence alone", () => {
    const document = parseHbomDocument(
      baseDoc([
        {
          id: "HBOM-0001",
          asComponentId: null,
          mpn: {
            value: "BCM6755",
            provenance: "inferred",
            confidence: 0.99,
            by: "bb-agent",
            at: "2026-07-29T14:02:11.000Z",
          },
        },
      ]),
    );
    expect(deriveHbomCellState(document.parts[0]?.mpn)).toBe("proposal");
    expect(
      deriveHbomCellState({
        value: "BCM6755",
        provenance: "inferred",
        confidence: 0.99,
        by: "bb-agent",
        at: "2026-07-29T14:02:11.000Z",
        accepted: {
          by: "reviewer",
          at: "2026-07-30T09:14:00.000Z",
        },
      }),
    ).toBe("verified");
  });

  it("marks competing candidates as conflict", () => {
    expect(
      deriveHbomCellState({
        value: "A",
        provenance: "bom_import",
        confidence: 0.8,
        by: "agent",
        at: "2026-07-29T14:02:11.000Z",
        candidates: [
          {
            value: "B",
            provenance: "datasheet",
            confidence: 0.7,
            by: "agent",
            at: "2026-07-29T14:02:11.000Z",
          },
        ],
      }),
    ).toBe("conflict");
  });
});
