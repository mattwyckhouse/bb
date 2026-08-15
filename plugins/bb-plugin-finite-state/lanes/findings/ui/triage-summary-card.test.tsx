// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";

beforeAll(() => installTestPluginRuntime());
afterEach(() => cleanup());

const RUN_ID = "tr-20260811-1402";

function versions() {
  return {
    versions: [
      {
        platformProjectId: "platform-1",
        projectVersionId: "version-1",
        asOf: "2026-08-15T00:00:00.000Z",
        state: "fresh" as const,
      },
    ],
    selectedPlatformProjectId: "platform-1",
    selectedProjectVersionId: "version-1",
  };
}

function summary() {
  return {
    runId: RUN_ID,
    source: "policy" as const,
    status: "completed" as const,
    dryRun: false,
    written: 39,
    held: 2,
    conflicts: 0,
    skippedExisting: 1,
    errors: 0,
    holdbacks: [
      {
        stableKey: "acme|pkg:generic/busybox@1|CVE-2023-1",
        rule: "hold-kev",
        why: "KEV requires human review",
      },
    ],
    createdAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:01:00.000Z",
  };
}

describe("TriageSummaryCard", () => {
  it("self-fetches by run id through triageSummaryGet", async () => {
    const { TriageSummaryCard } = await import("./TriageSummaryCard.js");
    const slot = renderSlot(
      { component: () => <TriageSummaryCard id={RUN_ID} /> },
      {},
      {
        context: { projectId: "workspace-1" },
        rpc: {
          cachedProjectVersions: () => versions(),
          triageSummaryGet: () => summary(),
        },
      },
    );
    expect(await slot.findByLabelText(`Triage summary ${RUN_ID}`)).toBeTruthy();
    expect(slot.getByText(/39/)).toBeTruthy();
    expect(slot.getByText(/KEV requires human review/)).toBeTruthy();
    expect(slot.inspection.rpcCalls).toContainEqual(
      expect.objectContaining({
        method: "triageSummaryGet",
        input: {
          projectId: "platform-1",
          projectVersionId: "version-1",
          runId: RUN_ID,
        },
      }),
    );
  });

  it("rejects an invalid run id before RPC", async () => {
    const { TriageSummaryCard } = await import("./TriageSummaryCard.js");
    const slot = renderSlot(
      { component: () => <TriageSummaryCard id="../escape" /> },
      {},
      {
        context: { projectId: "workspace-1" },
        rpc: {
          cachedProjectVersions: () => versions(),
          triageSummaryGet: () => summary(),
        },
      },
    );
    expect(await slot.findByText("Invalid triage run identity")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("renders missing and retryable error states", async () => {
    const { TriageSummaryCard } = await import("./TriageSummaryCard.js");
    const missing = renderSlot(
      { component: () => <TriageSummaryCard id={RUN_ID} /> },
      {},
      {
        context: { projectId: "workspace-1" },
        rpc: {
          cachedProjectVersions: () => versions(),
          triageSummaryGet: () =>
            Promise.reject(new Error("TRIAGE_RUN_NOT_FOUND")),
        },
      },
    );
    expect(await missing.findByText("Triage run not found")).toBeTruthy();

    let attempts = 0;
    const failing = renderSlot(
      { component: () => <TriageSummaryCard id={RUN_ID} /> },
      {},
      {
        context: { projectId: "workspace-1" },
        rpc: {
          cachedProjectVersions: () => versions(),
          triageSummaryGet: () => {
            attempts += 1;
            return Promise.reject(new Error("Injected triage failure"));
          },
        },
      },
    );
    expect(await failing.findByText("Injected triage failure")).toBeTruthy();
    fireEvent.click(failing.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
  });
});
