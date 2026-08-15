import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";

export type DirectiveUiState =
  | "loading"
  | "empty"
  | "error"
  | "unconfigured"
  | "ready";

export interface DirectiveBoundaryProps {
  /** Original directive source; used as the crash fallback literal. */
  source: string;
  children: ReactNode;
  onRetry?: () => void;
}

interface DirectiveBoundaryState {
  crashed: boolean;
}

/**
 * Shared message-directive shell: designed loading / empty / error /
 * unconfigured states, plus an ErrorBoundary that never takes down the
 * surrounding assistant message.
 */
export class DirectiveBoundary extends Component<
  DirectiveBoundaryProps,
  DirectiveBoundaryState
> {
  state: DirectiveBoundaryState = { crashed: false };

  static getDerivedStateFromError(): DirectiveBoundaryState {
    return { crashed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Host already isolates the message tree; keep a bounded local fallback.
  }

  override render(): ReactNode {
    if (this.state.crashed) {
      return (
        <DirectiveCrashFallback
          onRetry={
            this.props.onRetry
              ? () => {
                  this.setState({ crashed: false });
                  this.props.onRetry?.();
                }
              : () => this.setState({ crashed: false })
          }
          source={this.props.source}
        />
      );
    }
    return this.props.children;
  }
}

export function DirectiveLoadingState({
  label,
}: {
  label: string;
}): React.JSX.Element {
  return (
    <div
      aria-label={label}
      className="my-3 space-y-2 rounded-lg border border-border bg-card p-4"
      role="status"
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

export function DirectiveEmptyState({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}): React.JSX.Element {
  return (
    <article className="my-3 rounded-lg border border-dashed border-border bg-card p-4 text-sm">
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          name="FileQuestion"
        />
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-muted-foreground">{detail}</p>
          {actionLabel && onAction ? (
            <Button
              className="mt-3"
              onClick={onAction}
              size="sm"
              type="button"
              variant="outline"
            >
              {actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function DirectiveErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <article
      className="my-3 rounded-lg border border-destructive/40 bg-card p-4 text-sm"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-destructive"
          name="AlertCircle"
        />
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">{title}</h3>
          <p className="mt-1 break-words text-muted-foreground">{detail}</p>
          {onRetry ? (
            <Button
              className="mt-3"
              onClick={onRetry}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function DirectiveUnconfiguredState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.JSX.Element {
  return (
    <article className="my-3 rounded-lg border border-border bg-card p-4 text-sm">
      <div className="flex items-start gap-3">
        <Icon
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          name="Settings"
        />
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-muted-foreground">{detail}</p>
        </div>
      </div>
    </article>
  );
}

export function DirectiveInvalidAttributes({
  issues,
}: {
  source: string;
  issues: readonly string[];
}): React.JSX.Element {
  return (
    <DirectiveErrorState
      detail={
        issues.length > 0
          ? issues.slice(0, 3).join("; ")
          : "The directive attributes were rejected before any request."
      }
      title="Invalid directive attributes"
    />
  );
}

function DirectiveCrashFallback({
  source,
  onRetry,
}: {
  source: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <article
      className="my-3 rounded-lg border border-destructive/40 bg-card p-4 text-sm"
      role="alert"
    >
      <h3 className="font-semibold">Directive failed to render</h3>
      <p className="mt-1 text-muted-foreground">
        The message stays intact. Showing the original directive text.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs text-foreground">
        {source.slice(0, 512)}
      </pre>
      <Button
        className="mt-3"
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </article>
  );
}

export function DirectiveShell({
  children,
  openLabel,
  onOpen,
}: {
  children: ReactNode;
  openLabel: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="min-w-0">{children}</div>
      <div className="flex items-center justify-end border-t border-border bg-muted/30 px-2 py-1">
        <Button
          aria-label={openLabel}
          className="h-8 gap-1.5 px-2"
          onClick={onOpen}
          size="sm"
          type="button"
          variant="ghost"
        >
          <span className="text-xs">{openLabel}</span>
          <Icon aria-hidden="true" className="size-3.5" name="ArrowUpRight" />
        </Button>
      </div>
    </div>
  );
}
