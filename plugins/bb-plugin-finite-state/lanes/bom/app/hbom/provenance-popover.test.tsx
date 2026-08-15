// @vitest-environment jsdom

import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";
import type { HbomCellView } from "../../hbom/cell-view.js";

beforeAll(() => installTestPluginRuntime());
afterEach(() => cleanup());

const cell: HbomCellView = {
  partId: "HBOM-0001",
  field: "mpn",
  value: "BCM6755KFEBG",
  state: "proposal",
  confidence: 0.72,
  sourceRef: {
    documentSha256: "a".repeat(64),
    locator: { kind: "sheet", sheet: "Sheet1", cell: "A14" },
  },
  acceptedBy: null,
  acceptedAt: null,
  candidateCount: 1,
};

async function popoverRegistration(
  props: React.ComponentProps<
    typeof import("./provenance-popover.js").ProvenancePopover
  >,
) {
  const module = await import("./provenance-popover.js");
  return {
    component: () => <module.ProvenancePopover {...props} />,
  };
}

describe("ProvenancePopover", () => {
  it("links page/bbox and sheet/cell sources and lists competing claims", async () => {
    const slot = renderSlot(
      await popoverRegistration({
        onClose: () => undefined,
        state: {
          kind: "ready",
          cell,
          provenance: "bom_import",
          extractor: "bb-agent",
          extractedAt: "2026-07-29T14:02:11.000Z",
          note: null,
          competing: [
            {
              value: "BCM6755KFEB",
              provenance: "datasheet",
              confidence: 0.61,
              sourceRef: {
                documentSha256: "b".repeat(64),
                locator: { kind: "pdf", page: 7, bbox: [0.1, 0.2, 0.3, 0.4] },
              },
            },
          ],
          documentMissing: false,
          documentWithdrawn: false,
        },
      }),
      {},
    );
    expect(slot.getByText(/Sheet1!A14/u)).toBeTruthy();
    expect(slot.getAllByText(/BCM6755KFEB/u).length).toBeGreaterThan(0);
    expect(slot.getByText(/p\.7/u)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Open source/u }));
    expect(slot.inspection.navigateCalls.length).toBeGreaterThan(0);
  });

  it("renders a recovery message when the cited document is missing", async () => {
    const slot = renderSlot(
      await popoverRegistration({
        onClose: () => undefined,
        state: {
          kind: "ready",
          cell,
          provenance: "bom_import",
          extractor: "bb-agent",
          extractedAt: "2026-07-29T14:02:11.000Z",
          note: null,
          competing: [],
          documentMissing: true,
          documentWithdrawn: false,
        },
      }),
      {},
    );
    expect(slot.getByText(/missing from the ledger/u)).toBeTruthy();
  });

  it("surfaces withdrawn-source guidance", async () => {
    const slot = renderSlot(
      await popoverRegistration({
        onClose: () => undefined,
        state: {
          kind: "ready",
          cell,
          provenance: "bom_import",
          extractor: "bb-agent",
          extractedAt: "2026-07-29T14:02:11.000Z",
          note: null,
          competing: [],
          documentMissing: false,
          documentWithdrawn: true,
        },
      }),
      {},
    );
    expect(slot.getByText(/Source withdrawn/u)).toBeTruthy();
  });
});
