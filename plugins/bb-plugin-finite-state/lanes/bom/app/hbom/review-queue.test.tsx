// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";
import { FRONTEND_CAPABILITY_PLACEHOLDER } from "./hbom-presentation.js";

class QueueResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            contentRect: new DOMRectReadOnly(0, 0, 1200, 800),
            borderBoxSize: [{ blockSize: 800, inlineSize: 1200 }],
            contentBoxSize: [{ blockSize: 800, inlineSize: 1200 }],
            devicePixelContentBoxSize: [{ blockSize: 800, inlineSize: 1200 }],
          },
        ],
        this,
      ),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  installTestPluginRuntime();
  vi.stubGlobal("ResizeObserver", QueueResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    toJSON() {
      return {};
    },
  });
});
afterEach(() => cleanup());

const DOC = "a".repeat(64);

function queuePage() {
  return {
    items: [
      {
        projectId: "project-1",
        projectVersionId: null,
        kind: "hbomReviewCell",
        key: "HBOM-0001:mpn",
        label: "HBOM-0001 · mpn",
        fields: {
          partId: "HBOM-0001",
          field: "mpn",
          value: "BCM6755KFEBG",
          state: "proposal",
          confidence: 0.72,
          reason: "low_confidence",
          provenance: "bom_import",
          hbomSha256: "c".repeat(64),
          sourceRef: {
            documentSha256: DOC,
            encoded: `docs/${DOC}#Sheet1!A14`,
            locator: { kind: "sheet", sheet: "Sheet1", cell: "A14" },
          },
          candidates: [
            {
              index: 0,
              value: "BCM6755KFEB",
              provenance: "datasheet",
              confidence: 0.61,
              sourceRef: {
                documentSha256: DOC,
                locator: { kind: "pdf", page: 7 },
              },
            },
          ],
          acceptedBy: null,
          acceptedAt: null,
          candidateCount: 1,
        },
      },
    ],
    total: 1,
    next: null,
    cache: {
      state: "fresh" as const,
      asOf: "2026-08-14T00:00:00.000Z",
      message: null,
      acceptedGenerationId: null,
      baseRevision: 0,
    },
  };
}

async function queueRegistration() {
  const module = await import("./review-queue.js");
  return {
    component: () => (
      <module.ReviewQueue projectId="project-1" projectVersionId={null} />
    ),
  };
}

describe("ReviewQueue", () => {
  it("supports keyboard navigation, focus guard, filters, and blast-radius confirm", async () => {
    const resolve = vi.fn(async (_input: unknown): Promise<never> => {
      throw new Error("authorization-unavailable");
    });
    const slot = renderSlot(
      await queueRegistration(),
      {},
      {
        rpc: {
          hbomReviewList: () => queuePage(),
          hbomReviewResolve: resolve,
        },
      },
    );

    expect(await slot.findByText(/HBOM-0001 · mpn/u)).toBeTruthy();
    expect(slot.getByText(/low confidence/u)).toBeTruthy();

    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    const firstPayload = resolve.mock.calls[0]?.[0];
    expect(firstPayload).toMatchObject({
      decisions: [{ id: "HBOM-0001:mpn", action: "accept" }],
    });
    expect(
      typeof firstPayload === "object" &&
        firstPayload !== null &&
        "humanApprovalCapability" in firstPayload
        ? firstPayload.humanApprovalCapability
        : null,
    ).toBe(FRONTEND_CAPABILITY_PLACEHOLDER);
    expect(await slot.findByText(/authorization-unavailable/u)).toBeTruthy();
    expect(await slot.findByText(/HBOM-0001 · mpn/u)).toBeTruthy();

    resolve.mockClear();
    const fieldFilter = slot.getByLabelText("Field");
    fireEvent.focus(fieldFilter);
    fireEvent.keyDown(fieldFilter, { key: "a" });
    expect(resolve).not.toHaveBeenCalled();

    fireEvent.click(slot.getByRole("button", { name: /Select matching/u }));
    fireEvent.click(slot.getByRole("button", { name: /Bulk accept/u }));
    expect(
      await slot.findByText(/Accept 1 cells from aaaaaaaaaaaa/u),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Confirm accept/u }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(await slot.findByText(/authorization-unavailable/u)).toBeTruthy();
  });

  it("preserves edit draft when resolve reports stale/unavailable", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("HBOM_STALE");
    });
    const slot = renderSlot(
      await queueRegistration(),
      {},
      {
        rpc: {
          hbomReviewList: () => queuePage(),
          hbomReviewResolve: resolve,
        },
      },
    );
    await slot.findByText(/HBOM-0001 · mpn/u);
    fireEvent.keyDown(window, { key: "e" });
    const input = await slot.findByDisplayValue("BCM6755KFEBG");
    fireEvent.change(input, { target: { value: "HUMAN-MPN" } });
    fireEvent.click(slot.getByRole("button", { name: /Save human value/u }));
    expect(await slot.findByText(/draft was preserved/iu)).toBeTruthy();
    expect(slot.getByText(/Draft: HUMAN-MPN/u)).toBeTruthy();
  });
});
