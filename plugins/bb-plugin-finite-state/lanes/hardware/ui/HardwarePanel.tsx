import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbContext,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import type { RpcContract } from "../../../shared/contract.js";
import type { hardwareDiscoveryRpcContract } from "../register.js";
import { BoardTabStub } from "./board/index.js";
import { FabTabStub } from "./fab/index.js";
import { HardwareHeader } from "./HardwareHeader.js";
import { hardwareTabFromSubPath } from "./route.js";
import { useHardwareSelection } from "./selection.js";
import {
  HardwareEmptyState,
  HardwareErrorState,
  HardwareLoadingState,
} from "./states.js";
import { SchematicsTab } from "./schematics/SchematicsTab.js";

interface HardwareProject {
  projectKey: string;
  name: string;
}

export function HardwarePanel({
  subPath,
}: PluginNavPanelProps): React.JSX.Element {
  const { projectId } = useBbContext();
  const rpc = useRpc<RpcContract & typeof hardwareDiscoveryRpcContract>();
  const [, setHardwareSelection] = useHardwareSelection();
  const [projects, setProjects] = useState<HardwareProject[]>([]);
  const [projectKey, setProjectKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptyHint, setEmptyHint] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const activeTab = hardwareTabFromSubPath(subPath);

  const loadProjects = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    if (!projectId) {
      setProjects([]);
      setProjectKey("");
      setLoadedProjectId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let discovery = await rpc.call("hardwareDiscoveryRefresh", {
        projectId,
        projectVersionId: null,
      });
      for (
        let attempt = 0;
        (discovery.state === "queued" || discovery.state === "refreshing") &&
        attempt < 40;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        discovery = await rpc.call("hardwareDiscoveryStatus", {
          projectId,
          projectVersionId: null,
        });
      }
      if (discovery.state === "queued" || discovery.state === "refreshing")
        throw new Error("Hardware discovery did not reach a readable state.");
      if (discovery.message && discovery.state === "degraded")
        throw new Error(discovery.message);
      const page = await rpc.call("hardwareProjectsList", {
        projectId,
        projectVersionId: null,
        pageSize: 100,
        cursor: null,
      });
      if (loadGeneration.current !== generation) return;
      setProjects(page.items);
      setEmptyHint(discovery.worktreeincludeHint);
      setLoadedProjectId(projectId);
      setProjectKey((current) =>
        page.items.some((project) => project.projectKey === current)
          ? current
          : (page.items[0]?.projectKey ?? ""),
      );
    } catch (cause: unknown) {
      if (loadGeneration.current !== generation) return;
      setError(
        cause instanceof Error ? cause.message : "Hardware discovery failed.",
      );
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [projectId, rpc]);

  useEffect(() => {
    void loadProjects();
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadProjects, revision]);
  useEffect(() => {
    if (projectKey) setHardwareSelection({ projectKey, kind: null });
  }, [projectKey, setHardwareSelection]);

  const scopeReady = loadedProjectId === projectId;
  const visibleProjects = scopeReady ? projects : [];
  const visibleProjectKey = scopeReady ? projectKey : "";
  const content =
    loading || !scopeReady ? (
      <HardwareLoadingState />
    ) : error ? (
      <HardwareErrorState
        message={error}
        onRetry={() => setRevision((value) => value + 1)}
      />
    ) : !projectId || visibleProjects.length === 0 || !visibleProjectKey ? (
      <HardwareEmptyState detail={emptyHint} />
    ) : activeTab === "schematics" ? (
      <SchematicsTab projectId={projectId} projectKey={visibleProjectKey} />
    ) : activeTab === "board" ? (
      <BoardTabStub />
    ) : (
      <FabTabStub />
    );
  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <HardwareHeader
        activeTab={activeTab}
        onProjectChange={setProjectKey}
        projectKey={visibleProjectKey}
        projects={visibleProjects}
      />
      <div className="min-h-0 flex-1">{content}</div>
    </section>
  );
}
