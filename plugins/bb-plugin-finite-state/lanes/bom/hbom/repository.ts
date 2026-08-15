import { watch, type FSWatcher } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";

import {
  createDocumentLedgerLookup,
  rebuildHbomMirror,
  type HbomMirrorScope,
} from "./mirror.js";
import { HbomValidationError } from "./schema.js";
import {
  HBOM_CHANGED_CHANNEL,
  HBOM_WATCH_GLOB,
  type HbomDocument,
} from "./types.js";
import { HbomMissingError, readHbom } from "./yaml.js";

export interface HbomWatcherOptions {
  db: Database.Database;
  root: string;
  projectId: string;
  projectVersionId: string;
  publish(
    channel: typeof HBOM_CHANGED_CHANNEL,
    payload: { projectId: string },
  ): void;
  onError?(error: unknown): void;
  onValidationError?(error: HbomValidationError): void;
  debounceMs?: number;
}

export interface HbomWatcher {
  notify(): void;
  flush(): Promise<void>;
  close(): void;
  lastDocument(): HbomDocument | null;
  lastSha256(): string | null;
}

class DebouncedHbomWatcher implements HbomWatcher {
  readonly #options: HbomWatcherOptions;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #dirty = false;
  #closed = false;
  #native: FSWatcher | undefined;
  #lastDocument: HbomDocument | null = null;
  #lastSha256: string | null = null;

  constructor(options: HbomWatcherOptions) {
    this.#options = options;
  }

  attach(watcher: FSWatcher): void {
    this.#native = watcher;
  }

  lastDocument(): HbomDocument | null {
    return this.#lastDocument;
  }

  lastSha256(): string | null {
    return this.#lastSha256;
  }

  notify(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run();
    }, this.#options.debounceMs ?? 75);
  }

  async #run(): Promise<void> {
    if (this.#closed || !this.#dirty) return;
    if (this.#running !== undefined) return this.#running;
    this.#dirty = false;
    this.#running = (async () => {
      try {
        await this.#rebuild();
      } catch (error) {
        this.#options.onError?.(error);
      } finally {
        this.#running = undefined;
        if (this.#dirty) await this.#run();
      }
    })();
    return this.#running;
  }

  async #rebuild(): Promise<void> {
    const scope: Pick<HbomMirrorScope, "projectId" | "projectVersionId"> = {
      projectId: this.#options.projectId,
      projectVersionId: this.#options.projectVersionId,
    };
    const ledger = createDocumentLedgerLookup(this.#options.db, scope);
    let read;
    try {
      read = await readHbom(this.#options.root, { ledger });
    } catch (error) {
      if (error instanceof HbomMissingError) {
        // No file yet — leave any prior valid mirror intact.
        return;
      }
      if (error instanceof HbomValidationError) {
        // Malformed external YAML: retain prior valid mirror; publish no change.
        this.#options.onValidationError?.(error);
        return;
      }
      throw error;
    }

    rebuildHbomMirror(this.#options.db, read.document, {
      ...scope,
      fileSha256: read.sha256,
    });
    this.#lastDocument = read.document;
    this.#lastSha256 = read.sha256;
    this.#options.publish(HBOM_CHANGED_CHANNEL, {
      projectId: this.#options.projectId,
    });
  }

  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#dirty = true;
    await this.#run();
    if (this.#running !== undefined) await this.#running;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#native?.close();
  }
}

/**
 * Watch product-security/hbom through the lane registration seam.
 * Call from registerBom when that WP is allowed to wire the watcher.
 */
export async function watchHbom(
  options: HbomWatcherOptions,
): Promise<HbomWatcher> {
  if (!isAbsolute(options.root)) {
    throw new Error("HBOM watcher root must be absolute");
  }
  const root = await realpath(options.root);
  const directory = resolve(root, HBOM_WATCH_GLOB);
  await mkdir(directory, { recursive: true });
  const controller = new DebouncedHbomWatcher({ ...options, root });
  const native = watch(directory, { recursive: true }, () =>
    controller.notify(),
  );
  native.on("error", (error) => options.onError?.(error));
  controller.attach(native);
  controller.notify();
  return controller;
}

/** Testable debounce/coalescing surface for hosts that already own observation. */
export function createHbomWatcher(options: HbomWatcherOptions): HbomWatcher {
  return new DebouncedHbomWatcher(options);
}
