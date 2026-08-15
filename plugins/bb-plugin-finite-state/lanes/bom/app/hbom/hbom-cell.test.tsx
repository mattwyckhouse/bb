// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HbomCell } from "./hbom-cell.js";
import type { HbomCellView } from "../../hbom/cell-view.js";

afterEach(() => cleanup());

function cell(overrides: Partial<HbomCellView>): HbomCellView {
  return {
    partId: "HBOM-0001",
    field: "mpn",
    value: "BCM6755",
    state: "proposal",
    confidence: 0.72,
    sourceRef: null,
    acceptedBy: null,
    acceptedAt: null,
    candidateCount: 0,
    ...overrides,
  };
}

describe("HbomCell", () => {
  it("renders the trust matrix with accessible non-color labels", () => {
    const cases: Array<{ view: HbomCellView; label: RegExp; value: string }> = [
      {
        view: cell({
          state: "verified",
          confidence: 0.72,
          acceptedBy: "r",
          acceptedAt: "2026-08-14T00:00:00.000Z",
        }),
        label: /Verified/u,
        value: "BCM6755",
      },
      {
        view: cell({ state: "proposal", confidence: 0.95 }),
        label: /Proposal/u,
        value: "BCM6755",
      },
      {
        view: cell({ state: "proposal", confidence: 0.72 }),
        label: /Proposal · medium confidence/u,
        value: "BCM6755",
      },
      {
        view: cell({ state: "proposal", confidence: 0.4 }),
        label: /Proposal · low confidence/u,
        value: "BCM6755",
      },
      {
        view: cell({
          state: "conflict",
          candidateCount: 2,
          confidence: 0.7,
        }),
        label: /Conflict/u,
        value: "BCM6755",
      },
      {
        view: cell({ state: "unknown", value: null, confidence: null }),
        label: /Unknown/u,
        value: "—",
      },
      {
        view: cell({
          state: "not_applicable",
          value: null,
          confidence: 1,
        }),
        label: /Human-confirmed/u,
        value: "n/a",
      },
    ];

    for (const entry of cases) {
      cleanup();
      render(<HbomCell cell={entry.view} />);
      expect(
        screen.getByRole("button", {
          name: new RegExp(`${entry.value}.*${entry.label.source}`, "u"),
        }),
      ).toBeTruthy();
      expect(screen.getByText(entry.label)).toBeTruthy();
      expect(screen.getByText(entry.value)).toBeTruthy();
    }
  });

  it("keeps high-confidence unaccepted values labeled as proposals", () => {
    render(<HbomCell cell={cell({ state: "proposal", confidence: 0.99 })} />);
    expect(screen.getByText("Proposal")).toBeTruthy();
    expect(screen.queryByText("Verified")).toBeNull();
  });
});
