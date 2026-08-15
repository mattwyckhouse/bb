/** Stable cross-RPC marker for failures that never touched host disk. */
export const REJECTED_BEFORE_WRITE_PREFIX = "REJECTED_BEFORE_WRITE:";

const SLUG_REUSE_MESSAGE =
  /slug [“"][^”"]+[”"] was already used and cannot be reused\.?$/u;

/**
 * True when the failure happened before any host write (validation / slug
 * reuse / RPC input schema), so undo/redo history for the entity can stay.
 * Anything else — including CAS conflicts and unknown transport errors — is
 * treated as may-have-written and must invalidate.
 */
export function isRejectedBeforeWrite(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "CanvasEntityValidationError") return true;
  if (error.name === "CanvasSlugReuseError") return true;
  if (Reflect.get(error, "code") === "invalid_input") return true;
  if (error.message.startsWith(REJECTED_BEFORE_WRITE_PREFIX)) return true;
  if (SLUG_REUSE_MESSAGE.test(error.message)) return true;
  return false;
}

export function markRejectedBeforeWrite(error: Error): Error {
  if (error.message.startsWith(REJECTED_BEFORE_WRITE_PREFIX)) return error;
  const marked = new Error(`${REJECTED_BEFORE_WRITE_PREFIX} ${error.message}`);
  marked.name = error.name;
  return marked;
}

export function displayRejectedBeforeWriteMessage(message: string): string {
  return message.startsWith(REJECTED_BEFORE_WRITE_PREFIX)
    ? message.slice(REJECTED_BEFORE_WRITE_PREFIX.length).trimStart()
    : message;
}
