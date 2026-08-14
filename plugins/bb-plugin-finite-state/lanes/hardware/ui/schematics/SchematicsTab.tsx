import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import type { RpcContract } from "../../../../shared/contract.js";
import {
  HardwareCanvasUnavailableState,
  HardwareErrorState,
  HardwareLoadingState,
} from "../states.js";
import { useHardwareSelection } from "../selection.js";
import { buildSheetTree, SheetTree } from "./SheetTree.js";
import { SchematicsOverlayStub } from "./overlay/index.js";

const LazySheetCanvas = lazy(async () => {
  const module = await import("./SheetCanvas.js");
  return { default: module.SheetCanvas };
});

interface SheetRecord {
  sheetPath: string;
  name: string;
  parentSheetPath: string | null;
  breadcrumbs: Array<{ sheetPath: string; name: string }>;
  symbolCount: number;
}

interface ArtifactRecord {
  kind:
    | "sheet_svg"
    | "board_svg"
    | "glb"
    | "bom"
    | "netlist"
    | "gerber"
    | "drill"
    | "drc"
    | "erc";
  sheetPath: string | null;
  fresh: boolean;
}

interface Capability {
  installed: boolean;
  supported: boolean;
  version: string | null;
}

interface ExtractFailure {
  kind: ArtifactRecord["kind"];
  message: string;
}

function artifactSheetPath(sheetPath: string): string {
  return sheetPath.replace(/\.kicad_sch$/u, ".svg");
}

function artifactUrl(projectKey: string, sheetPath: string): string {
  const query = new URLSearchParams({
    project: projectKey,
    kind: "sheet_svg",
    sheet: sheetPath,
  });
  return `/api/v1/plugins/finite-state/http/hw/artifact?${query.toString()}`;
}

export function SchematicsTab({
  projectId,
  projectKey,
}: {
  projectId: string;
  projectKey: string;
}): React.JSX.Element {
  const rpc = useRpc<RpcContract>();
  const [, setHardwareSelection] = useHardwareSelection();
  const [sheets, setSheets] = useState<SheetRecord[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [selectedSheetPath, setSelectedSheetPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [extractFailures, setExtractFailures] = useState<ExtractFailure[]>([]);
  const [loadedProjectKey, setLoadedProjectKey] = useState("");
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    try {
      const sheetInput = {
        projectId,
        projectVersionId: null,
        projectKey,
        pageSize: 100,
        cursor: null,
      };
      const [sheetPage, artifactStatus] = await Promise.all([
        rpc.call("hardwareSheetsList", sheetInput),
        rpc.call("hardwareArtifactsStatus", {
          projectId,
          projectVersionId: null,
          projectKey,
        }),
      ]);
      if (loadGeneration.current !== generation) return;
      setSheets(sheetPage.items);
      setArtifacts(artifactStatus.artifacts);
      setCapability(artifactStatus.capability);
      setLoadedProjectKey(projectKey);
      setSelectedSheetPath((current) =>
        sheetPage.items.some((sheet) => sheet.sheetPath === current)
          ? current
          : (sheetPage.items[0]?.sheetPath ?? ""),
      );
    } catch (cause: unknown) {
      if (loadGeneration.current !== generation) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Hardware sheets could not be loaded.",
      );
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [projectId, projectKey, rpc]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load, revision]);
  useRealtime("hardware:changed", (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      Reflect.get(payload, "projectKey") === projectKey
    ) {
      setRevision((value) => value + 1);
    }
  });

  const requestExtract = async (): Promise<void> => {
    setExtracting(true);
    setExtractFailures([]);
    try {
      let job = await rpc.call("hardwareExtractStart", {
        projectId,
        projectVersionId: null,
        projectKey,
        kinds: ["sheet_svg"],
        force: true,
      });
      for (
        let attempt = 0;
        (job.state === "queued" || job.state === "running") && attempt < 40;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        job = await rpc.call("hardwareExtractStatus", {
          projectId,
          projectVersionId: null,
          jobId: job.jobId,
        });
      }
      const failures = job.failures.filter(
        (failure) => failure.kind === "sheet_svg",
      );
      setExtractFailures(failures);
      if (job.state === "queued" || job.state === "running")
        setExtractFailures([
          {
            kind: "sheet_svg",
            message: "Extraction did not reach a terminal state.",
          },
        ]);
      setRevision((value) => value + 1);
    } catch (cause: unknown) {
      setExtractFailures([
        {
          kind: "sheet_svg",
          message:
            cause instanceof Error ? cause.message : "Extraction failed.",
        },
      ]);
    } finally {
      setExtracting(false);
    }
  };

  const selectedSheet =
    sheets.find((sheet) => sheet.sheetPath === selectedSheetPath) ?? null;
  const tree = useMemo(() => buildSheetTree(sheets), [sheets]);
  const expectedArtifactPath = artifactSheetPath(selectedSheetPath);
  const selectedArtifact =
    artifacts.find(
      (artifact) =>
        artifact.kind === "sheet_svg" &&
        artifact.sheetPath === expectedArtifactPath,
    ) ?? null;
  const anyStale = artifacts.some(
    (artifact) => artifact.kind === "sheet_svg" && !artifact.fresh,
  );
  const svgUrl = selectedArtifact?.fresh
    ? artifactUrl(projectKey, expectedArtifactPath)
    : null;

  if (loading || loadedProjectKey !== projectKey)
    return <HardwareLoadingState />;
  if (error)
    return (
      <HardwareErrorState
        message={error}
        onRetry={() => setRevision((value) => value + 1)}
      />
    );
  return (
    <div className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)]">
      <SheetTree
        breadcrumb={selectedSheet?.breadcrumbs ?? []}
        nodes={tree}
        onSelect={(sheetPath) => {
          setSelectedSheetPath(sheetPath);
          setHardwareSelection({ projectKey, kind: null });
        }}
        selectedSheetPath={selectedSheetPath}
      />
      <section className="relative flex min-h-0 flex-col overflow-hidden bg-background">
        <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              {selectedSheet?.name ?? "No sheet selected"}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {selectedSheet?.symbolCount ?? 0} symbols
            </p>
          </div>
          <Button
            className="ml-auto"
            disabled={
              extracting ||
              capability?.installed !== true ||
              capability.supported !== true
            }
            onClick={() => void requestExtract()}
            size="sm"
            variant="outline"
          >
            <Icon name="ArrowReloadHorizontal" />
            {extracting ? "Extracting…" : "Re-extract"}
          </Button>
        </div>
        {anyStale ? (
          <div
            className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2 text-xs"
            role="status"
          >
            <Icon name="AlertTriangle" />
            <span className="mr-auto">
              The cached render is stale. Review the source change, then
              re-extract explicitly.
            </span>
            <Button
              disabled={extracting}
              onClick={() => void requestExtract()}
              size="sm"
              variant="outline"
            >
              Re-extract SVG
            </Button>
          </div>
        ) : null}
        {extractFailures.length > 0 ? (
          <div
            className="border-b border-destructive/40 bg-card px-3 py-2"
            role="alert"
          >
            <p className="text-xs font-semibold text-destructive">
              KiCad export failed
            </p>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
              {extractFailures.map((failure) => failure.message).join("\n")}
            </pre>
            <Button
              className="mt-2"
              disabled={extracting}
              onClick={() => void requestExtract()}
              size="sm"
              variant="outline"
            >
              Retry export
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {capability && (!capability.installed || !capability.supported) ? (
            <HardwareCanvasUnavailableState version={capability.version} />
          ) : !selectedSheet ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No parsed sheet is available.
            </div>
          ) : svgUrl ? (
            <Suspense
              fallback={
                <div
                  aria-label="Loading React Flow viewport"
                  className="m-4 h-[calc(100%-2rem)] animate-pulse rounded-lg border border-border bg-muted/30"
                />
              }
            >
              <LazySheetCanvas
                overlay={<SchematicsOverlayStub />}
                projectKey={projectKey}
                sheetPath={selectedSheet.sheetPath}
                svgUrl={svgUrl}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-md rounded-lg border border-border bg-card p-5 text-center">
                <Icon
                  className="mx-auto size-6 text-muted-foreground"
                  name="FileQuestion"
                />
                <h3 className="mt-3 text-sm font-semibold">
                  No current SVG for this sheet
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Extraction is explicit. Generate the cached vector artifact
                  when you are ready.
                </p>
                <Button
                  className="mt-4"
                  disabled={
                    extracting ||
                    capability?.installed !== true ||
                    capability.supported !== true
                  }
                  onClick={() => void requestExtract()}
                  size="sm"
                >
                  <Icon name="ArrowReloadHorizontal" />
                  Extract schematic
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
