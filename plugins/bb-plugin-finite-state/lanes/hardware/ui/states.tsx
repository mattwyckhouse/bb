import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

function StateFrame({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      {children}
    </div>
  );
}

export function HardwareLoadingState(): React.JSX.Element {
  return (
    <div
      aria-label="Loading hardware projects"
      className="grid h-full min-h-0 grid-cols-[17rem_minmax(0,1fr)]"
    >
      <div className="space-y-3 border-r border-border p-4">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        {["w-4/5", "w-3/5", "w-2/3"].map((width) => (
          <div
            className={`h-8 ${width} animate-pulse rounded-md bg-muted`}
            key={width}
          />
        ))}
      </div>
      <div className="m-4 animate-pulse rounded-lg border border-border bg-muted/30" />
    </div>
  );
}

export function HardwareEmptyState({
  detail,
}: {
  detail?: string | null;
}): React.JSX.Element {
  return (
    <StateFrame>
      <div className="max-w-lg rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <Icon
          className="mx-auto size-7 text-muted-foreground"
          name="FolderOpen"
        />
        <h2 className="mt-3 text-lg font-semibold">
          No KiCad project in this workspace
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Commit the project files, or add an untracked design to{" "}
          <code className="rounded bg-muted px-1 font-mono text-xs">
            .worktreeinclude
          </code>{" "}
          so bb can bring it into this worktree.
        </p>
        {detail ? (
          <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </StateFrame>
  );
}

export function HardwareErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void;
}): React.JSX.Element {
  return (
    <StateFrame>
      <div className="max-w-xl rounded-lg border border-destructive/40 bg-card p-6">
        <div className="flex items-center gap-2">
          <Icon className="text-destructive" name="AlertTriangle" />
          <h2 className="text-base font-semibold">
            Hardware data could not be loaded
          </h2>
        </div>
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
          {message}
        </pre>
        <Button className="mt-4" onClick={onRetry} size="sm" variant="outline">
          <Icon name="ArrowReloadHorizontal" />
          Retry
        </Button>
      </div>
    </StateFrame>
  );
}

export function HardwareCanvasUnavailableState({
  version,
}: {
  version: string | null;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground" name="AlertCircle" />
          <h3 className="text-sm font-semibold">
            Schematic rendering unavailable
          </h3>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Install KiCad 7 or newer on this host, then explicitly extract this
          project. Parsed sheets remain available in the navigator.
        </p>
        {version ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Detected {version}
          </p>
        ) : null}
      </div>
    </div>
  );
}
