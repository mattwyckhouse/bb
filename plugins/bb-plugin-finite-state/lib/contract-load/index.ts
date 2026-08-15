import type { BbPluginApi } from "@bb/plugin-sdk";

import type { Store } from "../store/index.js";
import {
  contractLoadScope,
  loadRepoContract,
  type ContractLoadResult,
} from "./loader.js";
import { repoContractIdentity } from "./projection-key.js";

/**
 * The interval only schedules key checks. Each check reads HEAD and hashes the
 * two tracked contract trees; YAML parsing occurs only when that key changes.
 */
export const CONTRACT_LOAD_CHECK_INTERVAL_MS = 5_000;

export interface RepoContractCheckResult {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly result: ContractLoadResult;
}

export interface RepoContractMonitor {
  /** Deterministic movement trigger for tests and explicit refresh callers. */
  checkNow(): Promise<readonly RepoContractCheckResult[]>;
  start(signal: AbortSignal): Promise<void>;
}

function abortableInterval(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, CONTRACT_LOAD_CHECK_INTERVAL_MS);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

export function createRepoContractMonitor(
  bb: BbPluginApi,
  store: Store,
  log: BbPluginApi["log"],
): RepoContractMonitor {
  let pending: Promise<readonly RepoContractCheckResult[]> = Promise.resolve(
    [],
  );

  async function runCheck(): Promise<readonly RepoContractCheckResult[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    const roots = new Set<string>();
    const selected = projects
      .map((project) => ({
        project,
        source:
          project.sources.find((candidate) => candidate.isDefault) ??
          project.sources[0],
      }))
      .filter((value) => value.source !== undefined)
      .sort((left, right) => left.project.id.localeCompare(right.project.id));
    const results: RepoContractCheckResult[] = [];
    for (const { project, source } of selected) {
      if (source === undefined) continue;
      try {
        const identity = await repoContractIdentity(source.path);
        if (roots.has(identity.canonicalRoot)) continue;
        roots.add(identity.canonicalRoot);
        const result = await loadRepoContract(
          identity.canonicalRoot,
          store,
          contractLoadScope(identity.repositoryDigest),
        );
        results.push({
          projectId: project.id,
          workspaceRoot: identity.canonicalRoot,
          result,
        });
        if (result.rebuilt) {
          for (const diagnostic of result.diagnostics) {
            log.warn(
              `Repository contract diagnostic ${project.id}/${diagnostic.path}: ${diagnostic.message}`,
            );
          }
          const payload = {
            projectId: identity.projectId,
            projectVersionId: identity.projectVersionId,
          };
          bb.realtime.publish("requirements:changed", payload);
          bb.realtime.publish("tara:changed", payload);
          bb.realtime.publish("findings:changed", payload);
        }
      } catch (error) {
        log.warn(
          `Repository contract load skipped ${project.id} (${source.path}): ${errorDetail(error)}`,
        );
      }
    }
    return results;
  }

  return {
    checkNow() {
      const next = pending.then(runCheck, runCheck);
      pending = next;
      return next;
    },
    async start(signal) {
      while (!signal.aborted) {
        await this.checkNow();
        await abortableInterval(signal);
      }
    },
  };
}

export function registerRepoContractLoadService(
  bb: BbPluginApi,
  store: Store,
  log: BbPluginApi["log"],
): RepoContractMonitor {
  const monitor = createRepoContractMonitor(bb, store, log);
  bb.background.service("repo-contract-load", {
    start: (signal) => monitor.start(signal),
  });
  return monitor;
}

export { contractLoadScope, loadRepoContract } from "./loader.js";
export {
  computeProjectionKey,
  repoContractIdentity,
} from "./projection-key.js";
