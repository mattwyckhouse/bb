// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { connectedRemoteStatus } from "../../../../test/app-connections.js";
import { FINDINGS_DRIFT_CHANGED_CHANNEL } from "../../drift/report.js";

class DriftResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => vi.stubGlobal("ResizeObserver", DriftResizeObserver));
afterEach(() => cleanup());

const cache = {
  state: "fresh" as const,
  asOf: "2026-08-14T12:00:00.000Z",
  message: null,
  acceptedGenerationId: "generation-1",
  baseRevision: 1,
};

function driftReport(runId: string) {
  return {
    pvId: "version-1",
    runId,
    createdAt: "2026-08-14T12:00:00.000Z",
    unclassifiedCount: 3,
    totals: {
      reattached_noop: 1,
      reapply: 0,
      stale: 0,
      orphaned: 1,
      conflict: 0,
      needs_completion: 0,
    },
    items: [
      {
        stableKey: "project|component|CVE-2026-147",
        state: "orphaned" as const,
        reason: "Canonical resolver found no match",
      },
    ],
    nextCursor: null as string | null,
  };
}

type TestDriftReport = ReturnType<typeof driftReport>;

function reportItem(runId: string, stableKey: string): TestDriftReport {
  const report = driftReport(runId);
  return { ...report, items: [{ ...report.items[0]!, stableKey }] };
}

describe("findings drift panel", () => {
  it("renders freshness metadata, refetches on the pull-complete hint, and confirms prune", async () => {
    const app = await loadPluginApp(() => import("../../../../app.js"));
    const panel = app.navPanels.find(
      (candidate) => candidate.path === "findings",
    );
    if (!panel) throw new Error("Findings panel is not registered");
    let report = driftReport("drift-run-1");
    let reportResponse: TestDriftReport | Promise<TestDriftReport> = report;
    let reportReads = 0;
    const pruneInputs: unknown[] = [];
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: "workspace-1" },
        sidebarThreads: {
          status: "ready",
          projects: [
            { id: "workspace-1", name: "Workspace", isPersonal: false },
          ],
        },
        rpc: {
          connectionsStatus: connectedRemoteStatus,
          cachedProjectVersions: () => ({
            versions: [
              {
                platformProjectId: "platform-1",
                projectVersionId: "version-1",
                asOf: "2026-08-14T12:00:00.000Z",
                state: "fresh" as const,
              },
            ],
            selectedPlatformProjectId: "platform-1",
            selectedProjectVersionId: "version-1",
          }),
          findingsSavedViewsGet: () => ({
            views: [],
            sha256: null,
            recoveredFromCorrupt: false,
          }),
          findingsUiList: () => ({
            items: [],
            total: 0,
            next: null,
            cache,
          }),
          findingsDriftReport: () => {
            reportReads += 1;
            return reportResponse;
          },
          findingsDriftOrphanState: () => ({
            baseStateSha256: "a".repeat(64),
            total: 1,
          }),
          triageOrphansPrune: (input) => {
            pruneInputs.push(input);
            return {
              projectId: "platform-1",
              projectVersionId: "version-1",
              runId: "orphan-prune-a",
              total: 1,
              applied: 1,
              failed: 0,
              results: [
                {
                  stableKey: "project|component|CVE-2026-147",
                  success: true,
                  error: null,
                },
              ],
            };
          },
        },
      },
    );

    expect(await slot.findByText("drift-run-1")).toBeTruthy();
    expect(slot.getByText(/3 unclassified/u)).toBeTruthy();
    expect(slot.getByText("project|component|CVE-2026-147")).toBeTruthy();
    expect(reportReads).toBe(1);
    expect(slot.getByLabelText("Vendor VEX file")).toBeTruthy();
    expect(
      slot.getByLabelText(/Overwrite existing local decisions/u),
    ).toBeTruthy();

    report = { ...driftReport("drift-run-2"), nextCursor: "cursor-2" };
    reportResponse = report;
    await slot.behavior.emitRealtime(FINDINGS_DRIFT_CHANGED_CHANNEL, {
      pvId: "version-1",
    });
    expect(await slot.findByText("drift-run-2")).toBeTruthy();
    expect(reportReads).toBe(2);

    reportResponse = reportItem(
      "drift-run-3",
      "project|component|CVE-2026-300",
    );
    fireEvent.click(slot.getByRole("button", { name: "Load more drift" }));
    expect(await slot.findByText("drift-run-3")).toBeTruthy();
    expect(slot.queryByText("project|component|CVE-2026-147")).toBeNull();

    reportResponse = {
      ...reportItem("drift-run-3", "project|component|CVE-2026-300"),
      nextCursor: "cursor-3",
    };
    await slot.behavior.emitRealtime(FINDINGS_DRIFT_CHANGED_CHANNEL, {
      pvId: "version-1",
    });
    expect(await slot.findByText("drift-run-3")).toBeTruthy();

    let resolveLatePage: (value: TestDriftReport) => void = () => undefined;
    reportResponse = new Promise<TestDriftReport>((resolve) => {
      resolveLatePage = resolve;
    });
    fireEvent.click(slot.getByRole("button", { name: "Load more drift" }));
    reportResponse = reportItem(
      "drift-run-4",
      "project|component|CVE-2026-400",
    );
    await slot.behavior.emitRealtime(FINDINGS_DRIFT_CHANGED_CHANNEL, {
      pvId: "version-1",
    });
    expect(await slot.findByText("drift-run-4")).toBeTruthy();
    resolveLatePage(
      reportItem("drift-run-3", "project|component|CVE-2026-LATE"),
    );
    await waitFor(() =>
      expect(slot.queryByText("project|component|CVE-2026-LATE")).toBeNull(),
    );

    fireEvent.click(
      slot.getByRole("button", { name: "Preview prune loaded orphans (1)" }),
    );
    expect(
      await slot.findByText("Remove 1 proven orphaned decisions?"),
    ).toBeTruthy();
    expect(pruneInputs).toHaveLength(0);

    fireEvent.click(slot.getByRole("button", { name: "Confirm prune" }));
    await waitFor(() => expect(pruneInputs).toHaveLength(1));
    expect(pruneInputs[0]).toMatchObject({
      stableKeys: ["project|component|CVE-2026-400"],
      expectedBaseStateSha256: "a".repeat(64),
    });
    expect(pruneInputs[0]).not.toEqual(
      expect.objectContaining({ confirmed: expect.anything() }),
    );
    expect(
      await slot.findByText(
        "Pruned 1 orphaned decisions in 1 CAS-guarded chunk(s)",
      ),
    ).toBeTruthy();
  });
});
