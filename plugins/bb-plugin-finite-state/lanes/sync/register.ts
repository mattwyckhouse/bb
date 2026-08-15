import type { BbPluginApi, PluginCliContext } from "@bb/plugin-sdk";
import { registerRepoContractLoadService } from "../../lib/contract-load/index.js";
import type { PluginContext } from "../../lib/context.js";
import type { RemoteServices } from "../../lib/remote/types.js";
import { openStore } from "../../lib/store/index.js";
import {
  AGENTIC_CLI_SLOT,
  FINITE_STATE_COMMAND,
  withContributedSubtrees,
  type AgenticCliSlot,
} from "../agentic/cli/metadata.js";
import { FINDINGS_DRIFT_CHANGED_CHANNEL } from "../findings/drift/report.js";
import { registerSyncCli } from "./cli.js";
import type { NamespacedCliRunner } from "./cli.js";
import { registerAdapter, registerResolver } from "./engine/adapter.js";
import type { EngineDeps, PullPublication } from "./engine/pull.js";
import {
  createVexDecisionAdapter,
  createVexDecisionResolver,
  fastForwardVexWorking,
} from "./entities/vex-decision.js";
import { registerSyncRpc } from "./rpc.js";

async function resolveSyncWorktreeRoot(
  ctx: PluginContext,
  cliContext: PluginCliContext,
): Promise<{ worktreeRoot: string; workspaceProjectId: string }> {
  if (!cliContext.threadId) {
    throw new Error(
      "SYNC_EXECUTION_CONTEXT_REQUIRED: invoke from a bb thread; cwd is not trusted as a worktree identity",
    );
  }
  const thread = await ctx.bb.sdk.threads.get({
    threadId: cliContext.threadId,
  });
  if (
    !thread.environmentId ||
    (cliContext.projectId !== undefined &&
      thread.projectId !== cliContext.projectId)
  ) {
    throw new Error(
      "SYNC_EXECUTION_CONTEXT_INVALID: thread project/environment mismatch",
    );
  }
  const environment = await ctx.bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (environment.projectId !== thread.projectId || !environment.path) {
    throw new Error(
      "SYNC_EXECUTION_CONTEXT_INVALID: environment has no verified workspace path",
    );
  }
  return {
    worktreeRoot: environment.path,
    workspaceProjectId: thread.projectId,
  };
}

/**
 * Kind-specific invalidation after the engine's accepted-pointer flip.
 * The engine must invoke this only after `publishGeneration` commits.
 */
export function emitAcceptedPullHints(
  publish: BbPluginApi["realtime"]["publish"],
  publication: PullPublication,
): void {
  const { scope, kinds } = publication;
  if (scope.projectVersionId === null) return;
  const payload = {
    projectId: scope.projectId,
    projectVersionId: scope.projectVersionId,
  };
  if (kinds.includes("sbomComponent")) {
    publish("bom:changed", {
      projectVersionId: scope.projectVersionId,
    });
  }
  if (kinds.includes("finding")) {
    publish("findings:changed", payload);
    publish(FINDINGS_DRIFT_CHANGED_CHANNEL, {
      pvId: scope.projectVersionId,
    });
  }
  if (kinds.includes("requirement")) {
    publish("requirements:changed", payload);
  }
  if (kinds.includes("threat")) {
    publish("tara:changed", payload);
  }
}

export function registerSync(bb: BbPluginApi, ctx: PluginContext): void {
  registerRepoContractLoadService(bb, openStore(bb), ctx.log);
  const remote = ctx.service<RemoteServices>("remote-services", () => {
    throw new Error("Sync registration requires remote services");
  });
  registerAdapter(
    createVexDecisionAdapter(remote.platform, ctx.db(), (advisory) => {
      ctx.log.warn(
        `VEX remote row isolated: ${advisory.code}; finding=${advisory.findingId ?? "unknown"}`,
      );
    }),
  );
  registerResolver("vexDecision", createVexDecisionResolver(remote.platform));
  const deps: EngineDeps = {
    db: ctx.db(),
    worktreeRoot: null,
    publish: (channel, progress) => ctx.bb.realtime.publish(channel, progress),
    // Keep kind-specific channels so mounted consumers only invalidate the
    // accepted surface they read. The engine invokes this callback after the
    // atomic generation publish has committed.
    published: (publication) =>
      emitAcceptedPullHints(ctx.bb.realtime.publish, publication),
    fastForwardWorking: async ({ adapter, baseRows, files, worktreeRoot }) => {
      if (adapter.kind === "vexDecision") {
        await fastForwardVexWorking(worktreeRoot, files, baseRows);
      }
    },
  };
  registerSyncRpc(bb, deps, remote.assuranceStudio);
  const raw = registerSyncCli(
    bb,
    deps,
    remote.platform,
    remote.assuranceStudio,
    (cliContext) => resolveSyncWorktreeRoot(ctx, cliContext),
    {
      firmware: (argv, cliContext) =>
        ctx
          .service<{ run: NamespacedCliRunner }>("firmware.cli", () => {
            throw new Error("Firmware CLI services are unavailable");
          })
          .run(argv, cliContext),
      bench: (argv, cliContext) =>
        ctx
          .service<{ run: NamespacedCliRunner }>("bench.cli", () => {
            throw new Error("Bench CLI services are unavailable");
          })
          .run(argv, cliContext),
      triage: (argv, cliContext) =>
        ctx
          .service<{ run: NamespacedCliRunner }>("findings.cli", () => {
            throw new Error("Findings CLI services are unavailable");
          })
          .run(argv, cliContext),
    },
    {
      summary: FINITE_STATE_COMMAND.summary,
      commands: withContributedSubtrees(),
      intercept: async (argv, cliContext) => {
        const slot = ctx.service<AgenticCliSlot>(AGENTIC_CLI_SLOT, () => ({
          run: null,
        }));
        if (slot.run === null) return null;
        return slot.run(argv, cliContext);
      },
    },
  );
  ctx.service<{ run: NamespacedCliRunner }>("sync.cli", () => ({ run: raw }));
}
