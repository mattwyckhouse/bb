import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { useBbNavigate } from "@bb/plugin-sdk/app";
import type { BomRoute } from "../sbom/routes.js";
import { HbomGrid } from "./hbom-grid.js";
import { PartDetail } from "./part-detail.js";
import { ReviewQueue } from "./review-queue.js";

export interface HbomRoutesProps {
  route: Extract<BomRoute, { tab: "hardware" }>;
  workspaceProjectId: string | null;
}

function IngestPlaceholder({
  projectId,
}: {
  projectId: string | null;
}): React.JSX.Element {
  const navigate = useBbNavigate();
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6">
        <Icon
          aria-hidden="true"
          className="mb-3 size-6 text-muted-foreground"
          name="PackageReceive"
        />
        <h2 className="text-lg font-semibold">HBOM ingest</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Document upload and extraction apply land in WP-46. Until then, open
          Documents to register evidence files, then return here to review
          proposals
          {projectId ? ` for ${projectId}` : ""}.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => navigate.toPluginPanel("documents", { subPath: "" })}
            size="sm"
            variant="secondary"
          >
            Open documents
          </Button>
          <Button
            onClick={() =>
              navigate.toPluginPanel("bom", { subPath: "hardware/review" })
            }
            size="sm"
            variant="outline"
          >
            Open review queue
          </Button>
        </div>
      </div>
    </div>
  );
}

export function HbomRoutes({
  route,
  workspaceProjectId,
}: HbomRoutesProps): React.JSX.Element {
  const navigate = useBbNavigate();

  const chrome = (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <Button
        aria-current={!route.screen && !route.partId ? "page" : undefined}
        onClick={() => navigate.toPluginPanel("bom", { subPath: "hardware" })}
        size="sm"
        variant={!route.screen && !route.partId ? "secondary" : "ghost"}
      >
        Grid
      </Button>
      <Button
        aria-current={route.screen === "review" ? "page" : undefined}
        onClick={() =>
          navigate.toPluginPanel("bom", { subPath: "hardware/review" })
        }
        size="sm"
        variant={route.screen === "review" ? "secondary" : "ghost"}
      >
        Review
      </Button>
      <Button
        aria-current={route.screen === "ingest" ? "page" : undefined}
        onClick={() =>
          navigate.toPluginPanel("bom", { subPath: "hardware/ingest" })
        }
        size="sm"
        variant={route.screen === "ingest" ? "secondary" : "ghost"}
      >
        Ingest
      </Button>
    </div>
  );

  if (!workspaceProjectId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chrome}
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
            <Icon
              aria-hidden="true"
              className="mx-auto size-6 text-muted-foreground"
              name="PackageReceive"
            />
            <h2 className="mt-3 text-base font-semibold">Choose a project</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              HBOM reads product-security/hbom/hbom.yaml from the selected
              workspace project.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (route.screen === "ingest") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chrome}
        <IngestPlaceholder projectId={workspaceProjectId} />
      </div>
    );
  }

  if (route.screen === "review") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chrome}
        <div className="min-h-0 flex-1">
          <ReviewQueue projectId={workspaceProjectId} projectVersionId={null} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {chrome}
      <div
        className={`grid min-h-0 flex-1 ${route.partId ? "grid-cols-12" : "grid-cols-1"}`}
      >
        <div className={route.partId ? "col-span-7 min-h-0" : "min-h-0"}>
          <HbomGrid
            onOpenPart={(partId) =>
              navigate.toPluginPanel("bom", {
                subPath: `hardware/${encodeURIComponent(partId)}`,
              })
            }
            projectId={workspaceProjectId}
            projectVersionId={null}
          />
        </div>
        {route.partId ? (
          <div className="col-span-5 min-h-0">
            <PartDetail
              id={route.partId}
              onClose={() =>
                navigate.toPluginPanel("bom", { subPath: "hardware" })
              }
              projectId={workspaceProjectId}
              projectVersionId={null}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
