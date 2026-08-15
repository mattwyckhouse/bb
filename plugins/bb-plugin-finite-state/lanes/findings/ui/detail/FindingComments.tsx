import { useCallback, useEffect, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Textarea } from "@bb/shared-ui/textarea";
import { useRpc } from "@bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../../../../shared/contract.js";
import type { FindingDetailRow } from "./useFindingDetail.js";
import { humanizeSectionError, nextCommentDraft } from "./user-error.js";

type Comment = z.output<
  (typeof rpcContract)["findingsCommentsList"]["output"]
>["items"][number];

const MUTATION_UNAVAILABLE =
  "Comment create, edit, and delete are unavailable in v1 (authorization). Cached comments stay readable; put durable reasoning in the local overlay.";

export function FindingComments({
  row,
  ambiguous,
}: {
  row: FindingDetailRow | null;
  ambiguous: boolean;
}): React.JSX.Element {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingOverwrite, setPendingOverwrite] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const load = useCallback(
    async (continuation: string | null) => {
      if (!row) return;
      const input = {
        projectId: row.projectId,
        projectVersionId: row.projectVersionId,
        findingId: row.findingId,
        pageSize: 25,
        continuation,
      };
      const result = await rpc.call("findingsCommentsList", input);
      setItems((current) =>
        continuation
          ? [
              ...current,
              ...result.items.filter(
                (item) => !current.some((existing) => existing.id === item.id),
              ),
            ]
          : result.items,
      );
      setCursor(result.next);
    },
    [row, rpc],
  );

  useEffect(() => {
    if (!row) return;
    let active = true;
    setLoading(true);
    setError(null);
    setErrorDetail(null);
    void load(null)
      .catch((cause: unknown) => {
        if (!active) return;
        const message = humanizeSectionError(
          cause,
          "Comments could not be loaded.",
        );
        setError(message.summary);
        setErrorDetail(message.detail);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, revision, row]);

  const copyIntoDraft = (commentText: string) => {
    const next = nextCommentDraft(draft, commentText, false);
    if (next !== null) {
      setDraft(next);
      setPendingOverwrite(null);
      return;
    }
    setPendingOverwrite(commentText);
  };

  const confirmOverwrite = (replace: boolean) => {
    if (pendingOverwrite === null) return;
    const next = nextCommentDraft(draft, pendingOverwrite, replace);
    if (next !== null) setDraft(next);
    setPendingOverwrite(null);
  };

  return (
    <section aria-labelledby="finding-comments" className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className="size-4 text-primary"
          name="MessageSquare"
        />
        <h3 className="text-sm font-semibold" id="finding-comments">
          Version-specific comments
        </h3>
      </div>
      <div className="rounded-lg border border-warning/40 bg-muted/30 p-3 text-xs">
        <p className="font-medium">
          Comments do not carry to another product version.
        </p>
        <p className="mt-1 text-muted-foreground">
          Put durable reasoning in the local overlay reason and evidence fields.
        </p>
      </div>
      {!row ? (
        <div className="rounded-lg border border-border bg-background p-3 text-xs">
          <p className="font-medium">
            Select a cached row before viewing or creating comments.
          </p>
          <p className="mt-1 text-muted-foreground">
            This stable identity resolves to multiple transient finding rows;
            choosing one avoids attaching a comment to the wrong
            version-specific UUID.
          </p>
        </div>
      ) : (
        <>
          <p className="break-all text-xs text-muted-foreground">
            Selected transient row:{" "}
            <span className="font-mono text-foreground">{row.findingId}</span>
          </p>
          {error ? (
            <div
              className="rounded-lg border border-destructive/40 bg-muted/20 p-3 text-xs"
              role="alert"
            >
              <p className="break-words">{error}</p>
              {errorDetail ? (
                <details className="mt-1 text-muted-foreground">
                  <summary className="cursor-pointer">Technical detail</summary>
                  <p className="mt-1 break-words font-mono">{errorDetail}</p>
                </details>
              ) : null}
              <Button
                className="mt-2"
                onClick={() => setRevision((current) => current + 1)}
                size="sm"
                variant="ghost"
              >
                Refresh cached comments
              </Button>
            </div>
          ) : null}
          {loading && items.length === 0 ? (
            <div aria-label="Loading finding comments" className="space-y-2">
              {[0, 1].map((item) => (
                <div
                  className="h-16 animate-pulse rounded-lg border border-border bg-muted"
                  key={item}
                />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              No comments cached for this product-version row.
            </p>
          ) : (
            <ol className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {items.map((comment) => (
                <li
                  className="rounded-lg border border-border bg-background p-3 text-xs [content-visibility:auto] [contain-intrinsic-size:auto_5rem]"
                  key={comment.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {comment.actorLabel ?? "Unknown actor"}
                      </p>
                      <time
                        className="text-muted-foreground"
                        dateTime={comment.createdAt}
                      >
                        {new Date(comment.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        aria-label={`Copy comment ${comment.id} into draft`}
                        onClick={() => copyIntoDraft(comment.text)}
                        size="icon"
                        variant="ghost"
                      >
                        <Icon
                          aria-hidden="true"
                          className="size-4"
                          name="Copy"
                        />
                      </Button>
                      <Button
                        aria-label={`Edit comment ${comment.id}`}
                        disabled
                        size="icon"
                        variant="ghost"
                      >
                        <Icon
                          aria-hidden="true"
                          className="size-4"
                          name="Edit"
                        />
                      </Button>
                      <Button
                        aria-label={`Delete comment ${comment.id}`}
                        disabled
                        size="icon"
                        variant="ghost"
                      >
                        <Icon
                          aria-hidden="true"
                          className="size-4"
                          name="Trash2"
                        />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words">
                    {comment.text}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {cursor ? (
            <Button
              disabled={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                void load(cursor)
                  .catch((cause: unknown) => {
                    const message = humanizeSectionError(
                      cause,
                      "The next comment page failed.",
                    );
                    setError(message.summary);
                    setErrorDetail(message.detail);
                  })
                  .finally(() => setLoadingMore(false));
              }}
              size="sm"
              variant="outline"
            >
              {loadingMore ? "Loading…" : "Load older comments"}
            </Button>
          ) : null}
          <div className="space-y-2">
            <Textarea
              aria-label="New finding comment"
              onChange={(event) => {
                setDraft(event.target.value);
                setPendingOverwrite(null);
              }}
              placeholder="Add version-specific context…"
              value={draft}
            />
            {pendingOverwrite !== null ? (
              <div
                className="rounded-lg border border-warning/40 bg-muted/30 p-3 text-xs"
                role="status"
              >
                <p className="font-medium">
                  Replace the unsaved comment draft?
                </p>
                <p className="mt-1 text-muted-foreground">
                  Your current draft will be lost if you replace it.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    onClick={() => confirmOverwrite(false)}
                    size="sm"
                    variant="outline"
                  >
                    Keep draft
                  </Button>
                  <Button
                    onClick={() => confirmOverwrite(true)}
                    size="sm"
                    variant="secondary"
                  >
                    Replace draft
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="rounded-lg border border-border bg-muted/20 p-2 text-xs text-muted-foreground">
              {MUTATION_UNAVAILABLE}
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {ambiguous
                  ? "Row selection is required for duplicate identities."
                  : "Human-only action; agent and directive surfaces cannot submit."}
              </p>
              <Button disabled size="sm">
                Add comment
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
