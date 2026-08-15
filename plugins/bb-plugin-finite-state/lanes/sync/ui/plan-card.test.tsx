// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";

const PLAN_ID = "01K2G8Z4Q9A1B2C3D4E5F6G7H8";

beforeAll(() => installTestPluginRuntime());
afterEach(() => cleanup());

function planPage(planId = PLAN_ID) {
  return {
    projectId: "project-1",
    projectVersionId: "version-1",
    planId,
    planSha256: "a".repeat(64),
    baseGenerationIds: {},
    baseRevisions: {},
    baseStateSha256: "b".repeat(64),
    createdAt: "2026-08-15T00:00:00.000Z",
    staleness: { asOf: "2026-08-15T00:00:00.000Z", degraded: false },
    items: [],
    summary: {
      creates: 2,
      updates: 3,
      deletes: 1,
      noops: 0,
      conflicts: 1,
      orphans: 0,
    },
    blastRadius: {
      requiresHumanReview: true,
      changed: 6,
      deletes: 1,
      remoteCalls: 2,
      surfaces: ["threat"],
    },
    validationErrors: [],
    total: 6,
    next: null,
    cache: {
      state: "fresh" as const,
      asOf: "2026-08-15T00:00:00.000Z",
      message: null,
      acceptedGenerationId: "gen-1",
      baseRevision: 1,
    },
  };
}

describe("PlanCard", () => {
  it("self-fetches by planId via syncPlan continuation", async () => {
    const { PlanCard } = await import("./PlanCard.js");
    const slot = renderSlot(
      { component: () => <PlanCard id={PLAN_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { syncPlan: () => planPage() },
      },
    );
    expect(await slot.findByLabelText(`Sync plan ${PLAN_ID}`)).toBeTruthy();
    expect(slot.getByText("Creates").parentElement?.textContent).toContain("2");
    expect(slot.inspection.rpcCalls[0]).toMatchObject({
      method: "syncPlan",
      input: { continuation: `fsp1:${PLAN_ID}:0` },
    });
  });

  it("rejects an invalid plan id before RPC", async () => {
    const { PlanCard } = await import("./PlanCard.js");
    const slot = renderSlot(
      { component: () => <PlanCard id="not-a-ulid" /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { syncPlan: () => planPage() },
      },
    );
    expect(await slot.findByText("Invalid plan identity")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("renders retryable RPC failure and navigates to Sync Review", async () => {
    let attempts = 0;
    const { PlanCard } = await import("./PlanCard.js");
    const failing = renderSlot(
      { component: () => <PlanCard id={PLAN_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: {
          syncPlan: () => {
            attempts += 1;
            return Promise.reject(new Error("Injected plan failure"));
          },
        },
      },
    );
    expect(await failing.findByText("Injected plan failure")).toBeTruthy();
    fireEvent.click(failing.getByRole("button", { name: "Retry" }));
    expect(attempts).toBeGreaterThanOrEqual(2);

    const ready = renderSlot(
      { component: () => <PlanCard id={PLAN_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { syncPlan: () => planPage() },
      },
    );
    fireEvent.click(
      await ready.findByRole("button", { name: "Open in Sync Review" }),
    );
    expect(ready.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toPluginPanel",
        path: "sync",
        options: { subPath: `plan/${PLAN_ID}` },
      }),
    );
  });

  it("renders an empty card for PLAN_NOT_FOUND without treating it as retryable success", async () => {
    const { PlanCard } = await import("./PlanCard.js");
    const slot = renderSlot(
      { component: () => <PlanCard id={PLAN_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: {
          syncPlan: () =>
            Promise.reject(new Error("PLAN_NOT_FOUND: sidecar missing")),
        },
      },
    );
    expect(await slot.findByText("Sync plan not found")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
