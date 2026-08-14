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
    nextCursor: null,
  };
}

describe("findings drift panel", () => {
  it("renders freshness metadata, refetches on the pull-complete hint, and confirms prune", async () => {
    const app = await loadPluginApp(() => import("../../../../app.js"));
    const panel = app.navPanels.find(
      (candidate) => candidate.path === "findings",
    );
    if (!panel) throw new Error("Findings panel is not registered");
    let report = driftReport("drift-run-1");
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
            return report;
          },
          findingsDriftOrphanState: () => ({
            baseStateSha256: "a".repeat(64),
            total: 1,
          }),
          findingsDriftPrune: (input) => {
            pruneInputs.push(input);
            const confirmed =
              typeof input === "object" &&
              input !== null &&
              Reflect.get(input, "confirmed") === true;
            return {
              baseStateSha256: "a".repeat(64),
              selected: 1,
              pruned: confirmed ? 1 : 0,
              files: confirmed ? [".fs/triage/component.yaml"] : [],
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

    report = driftReport("drift-run-2");
    await slot.behavior.emitRealtime(FINDINGS_DRIFT_CHANGED_CHANNEL, {
      pvId: "version-1",
    });
    expect(await slot.findByText("drift-run-2")).toBeTruthy();
    expect(reportReads).toBe(2);

    fireEvent.click(
      slot.getByRole("button", { name: "Preview prune loaded orphans (1)" }),
    );
    expect(
      await slot.findByText("Remove 1 proven orphaned decisions?"),
    ).toBeTruthy();
    expect(pruneInputs[0]).toMatchObject({ dryRun: true, confirmed: false });

    fireEvent.click(slot.getByRole("button", { name: "Confirm prune" }));
    await waitFor(() => expect(pruneInputs).toHaveLength(2));
    expect(pruneInputs[1]).toMatchObject({ dryRun: false, confirmed: true });
    expect(await slot.findByText("Pruned 1 orphaned decisions")).toBeTruthy();
  });
});
