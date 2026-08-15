/**
 * Finding-detail user copy helpers (FS-139 / FS-104 designed-state conventions).
 * Surfaces show a human summary; optional technical detail stays available for diagnosis.
 */

export interface UserFacingError {
  summary: string;
  detail: string | null;
}

const HTTP_PREFIX = /^(?:HTTP\s+\d{3}:\s*)+/iu;

function rawMessage(error: unknown, limit: number): string | null {
  if (!(error instanceof Error) || !error.message.trim()) return null;
  return error.message.trim().slice(0, limit);
}

/** Collapse nested `HTTP 500: HTTP 404: …` prefixes into a single status when present. */
function peelHttpPrefixes(raw: string): {
  status: string | null;
  rest: string;
} {
  const match = HTTP_PREFIX.exec(raw);
  if (!match) return { status: null, rest: raw };
  const statuses = [...raw.matchAll(/HTTP\s+(\d{3})/giu)].map(
    (item) => item[1],
  );
  const innermost = statuses.at(-1) ?? null;
  return { status: innermost, rest: raw.slice(match[0].length).trim() };
}

function humanizeTransport(raw: string, fallback: string): UserFacingError {
  const { status, rest } = peelHttpPrefixes(raw);
  if (status === null) {
    return { summary: raw, detail: null };
  }
  if (/project not found/iu.test(rest)) {
    return { summary: "The linked project could not be found.", detail: raw };
  }
  if (/not found/iu.test(rest)) {
    return { summary: `${fallback} was not found.`, detail: raw };
  }
  const body =
    rest.length > 0 ? rest : "The remote service rejected the request.";
  // Prefer a short human line; keep the raw concatenated transport string as detail only.
  return {
    summary: status ? `${fallback} (remote status ${status}).` : fallback,
    detail: raw.includes(body) ? raw : `${raw} — ${body}`,
  };
}

export function humanizeDetailError(
  error: unknown,
  fallback = "Finding detail could not be loaded.",
  limit = 300,
): UserFacingError {
  const raw = rawMessage(error, limit);
  if (!raw) return { summary: fallback, detail: null };

  if (/rpc output validation failed/iu.test(raw)) {
    return {
      summary:
        "Finding detail could not be loaded because the response was invalid.",
      detail: raw,
    };
  }

  if (HTTP_PREFIX.test(raw)) {
    return humanizeTransport(raw, "Finding detail could not be loaded");
  }

  return { summary: raw, detail: null };
}

/** Cross-link failure copy: never show concatenated transport prefixes as the primary reason. */
export function humanizeLinkError(error: unknown): UserFacingError {
  const raw = rawMessage(error, 240);
  if (!raw) return { summary: "Linked surface unavailable.", detail: null };
  if (HTTP_PREFIX.test(raw)) {
    return humanizeTransport(raw, "Linked surface unavailable");
  }
  return { summary: raw, detail: null };
}

export function humanizeSectionError(
  error: unknown,
  fallback: string,
): UserFacingError {
  const raw = rawMessage(error, 300);
  if (!raw) return { summary: fallback, detail: null };
  if (HTTP_PREFIX.test(raw)) {
    return humanizeTransport(raw, fallback.replace(/\.$/u, ""));
  }
  return { summary: raw, detail: null };
}

/**
 * Apply an edit-into-composer action without silently discarding an unsaved draft.
 * Returns the next draft, or null when the caller must confirm before replacing.
 */
export function nextCommentDraft(
  currentDraft: string,
  commentText: string,
  confirmed: boolean,
): string | null {
  if (currentDraft.trim().length === 0 || currentDraft === commentText) {
    return commentText;
  }
  if (!confirmed) return null;
  return commentText;
}
