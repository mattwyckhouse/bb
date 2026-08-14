import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HardwareSourceWatcher, refuseAutomaticExtraction } from "./watch.js";

/** Wait until `getCount()` is unchanged for `quietMs` (debounce settle), with a deadline. */
async function waitForQuiet(
  getCount: () => number,
  quietMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = getCount();
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = getCount();
    if (next !== last) {
      last = next;
      lastChangeAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangeAt >= quietMs) return;
  }
  throw new Error(
    `timed out waiting for call count to stay quiet for ${quietMs}ms`,
  );
}

async function renameOverSave(
  root: string,
  schematic: string,
  content: string,
): Promise<void> {
  const replacement = join(
    root,
    `replacement-${content.replaceAll(" ", "-")}-${Date.now()}`,
  );
  await writeFile(replacement, content);
  await rename(replacement, schematic);
}

/**
 * FSEvents attach is asynchronous. Prime with one rename, then wait for the
 * debounced callback — never rename on a tight interval or the debounce timer
 * is starved and onChange never fires.
 */
async function waitUntilWatchReady(
  root: string,
  schematic: string,
  onChange: { mock: { calls: unknown[] } },
  debounceMs: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  while (onChange.mock.calls.length === 0) {
    if (Date.now() >= deadline) {
      throw new Error("hardware source watch never became ready");
    }
    attempt += 1;
    await renameOverSave(root, schematic, `prime-${attempt}`);
    try {
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), {
        timeout: debounceMs + 750,
        interval: 10,
      });
    } catch {
      // FSEvents sometimes misses the first attach window; retry with a fresh rename.
    }
  }
}

describe("hardware source watch", () => {
  it("survives repeated rename-over-save events and only requests a source refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-hw-watch-"));
    const schematic = join(root, "board.kicad_sch");
    await writeFile(schematic, "before");
    const onChange = vi.fn();
    const onError = vi.fn();
    // Match production default so FSEvents multi-delivery (~50ms apart on Darwin)
    // coalesces instead of splitting into exact-count flakes under load.
    const debounceMs = 100;
    const watcher = new HardwareSourceWatcher({
      schematicPath: schematic,
      boardPath: null,
      onChange,
      onError,
      debounceMs,
    });
    watcher.start();

    await waitUntilWatchReady(root, schematic, onChange, debounceMs);
    await waitForQuiet(
      () => onChange.mock.calls.length,
      debounceMs + 50,
      2_000,
    );
    onChange.mockClear();

    for (const content of ["first save", "second save"]) {
      const callsBefore = onChange.mock.calls.length;
      await renameOverSave(root, schematic, content);
      await vi.waitFor(
        () => {
          expect(onChange.mock.calls.length).toBeGreaterThan(callsBefore);
        },
        { timeout: 5_000 },
      );
      await waitForQuiet(
        () => onChange.mock.calls.length,
        debounceMs + 50,
        2_000,
      );
    }

    watcher.stop();
    expect(onError).not.toHaveBeenCalled();
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onChange.mock.calls.every((call) => call[0] === "schematic")).toBe(
      true,
    );
  });

  it("refuses every automatic regeneration path, including active agent runs", () => {
    expect(() => refuseAutomaticExtraction(false)).toThrow(
      "explicit extraction request",
    );
    expect(() => refuseAutomaticExtraction(true)).toThrow(
      "during an agent run",
    );
  });
});
