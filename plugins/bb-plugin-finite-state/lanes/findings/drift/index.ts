import type { PluginContext } from "../../../lib/context.js";
import {
  registerCachePuller,
  registeredCachePullers,
} from "../../sync/engine/adapter.js";
import { classifyDrift, readDriftReport } from "./classify.js";
import { orphanBaseState, pruneOrphans } from "./orphans.js";
import { importVendorVexBytes } from "./vendor/import.js";
import { FINDINGS_DRIFT_CHANGED_CHANNEL, type DriftReport } from "./report.js";
import type { VendorImportResult } from "./vendor/import.js";

export * from "./classify.js";
export * from "./orphans.js";
export * from "./report.js";
export * from "./vendor/import.js";
export * from "./vendor/map.js";
export * from "./vendor/parse.js";

export interface FindingsDriftService {
  refresh(input: {
    root: string;
    projectId: string;
    pvId: string;
    limit?: number;
  }): DriftReport;
  report(input: {
    projectId: string;
    pvId: string;
    cursor?: string | null;
    limit?: number;
  }): DriftReport;
  orphanState(input: { projectId: string; pvId: string }): {
    baseStateSha256: string;
    total: number;
  };
  importVendorVex(input: {
    root: string;
    projectId: string;
    pvId: string;
    file: string;
    bytes: Uint8Array;
    vendor: string;
    overwrite: boolean;
    dryRun: boolean;
  }): Promise<VendorImportResult>;
  pruneOrphans(input: {
    root: string;
    projectId: string;
    pvId: string;
    stableKeys: string[];
    dryRun: boolean;
    confirmed: boolean;
    expectedBaseStateSha256: string;
  }): Promise<{
    baseStateSha256: string;
    selected: number;
    pruned: number;
    files: string[];
  }>;
}

/** Installs local drift/import services and one post-publication refetch hint. */
export function registerFindingsDrift(ctx: PluginContext): void {
  const db = ctx.db();
  const findingPuller = registeredCachePullers().find(
    (candidate) => candidate.kind === "finding",
  );
  if (findingPuller === undefined)
    throw new Error(
      "Findings drift requires the registered findings cache puller",
    );
  registerCachePuller("finding", async (scope, generationId, onProgress) => {
    const report = await findingPuller.pull(scope, generationId, onProgress);
    ctx.bb.realtime.publish(FINDINGS_DRIFT_CHANGED_CHANNEL, {
      pvId: scope.projectVersionId,
    });
    return report;
  });
  ctx.service<FindingsDriftService>("findings.drift", () => ({
    refresh(input) {
      const report = classifyDrift(
        {
          db,
          root: input.root,
          projectId: input.projectId,
          limit: input.limit,
        },
        input.pvId,
      );
      ctx.bb.realtime.publish(FINDINGS_DRIFT_CHANGED_CHANNEL, {
        pvId: input.pvId,
      });
      return report;
    },
    report: (input) =>
      readDriftReport(
        {
          db,
          projectId: input.projectId,
          cursor: input.cursor,
          limit: input.limit,
        },
        input.pvId,
      ),
    orphanState(input) {
      const state = orphanBaseState(db, input.projectId, input.pvId);
      return { baseStateSha256: state.sha256, total: state.rows.length };
    },
    async importVendorVex(input) {
      const result = await importVendorVexBytes(
        { db, root: input.root, projectId: input.projectId, pvId: input.pvId },
        input.file,
        input.bytes,
        input,
      );
      if (!input.dryRun && result.written > 0) {
        classifyDrift(
          { db, root: input.root, projectId: input.projectId },
          input.pvId,
        );
        ctx.bb.realtime.publish(FINDINGS_DRIFT_CHANGED_CHANNEL, {
          pvId: input.pvId,
        });
      }
      return result;
    },
    async pruneOrphans(input) {
      const result = await pruneOrphans(
        { db, root: input.root, projectId: input.projectId, pvId: input.pvId },
        input,
      );
      if (!input.dryRun && result.pruned > 0) {
        ctx.bb.realtime.publish(FINDINGS_DRIFT_CHANGED_CHANNEL, {
          pvId: input.pvId,
        });
      }
      return result;
    },
  }));
}
