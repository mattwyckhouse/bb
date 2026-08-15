import { describe, expect, it } from "vitest";

import type { Json, PlatformClient, RemotePage } from "../types.js";
import { resolvePlatformScopeNames } from "./scope-names.js";

function paged(
  pages: readonly (readonly Record<string, Json>[])[],
  reads: { count: number },
): AsyncIterable<RemotePage<Record<string, Json>>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const items of pages) {
        reads.count += 1;
        yield { items: [...items], total: null, next: null };
      }
    },
  };
}

describe("Platform scope display-name enrichment", () => {
  it("reads only the first page for targeted cached ids", async () => {
    const projectReads = { count: 0 };
    const versionReads = { count: 0 };
    const platform = {
      listProjects: () =>
        paged(
          [
            [{ id: "project-a", name: "Gateway" }],
            [{ id: "project-b", name: "Must not be crawled" }],
          ],
          projectReads,
        ),
      listVersions: () =>
        paged(
          [
            [{ id: "version-a", name: "2.4.0" }],
            [{ id: "version-b", name: "Must not be crawled" }],
          ],
          versionReads,
        ),
    } satisfies Pick<PlatformClient, "listProjects" | "listVersions">;

    await expect(
      resolvePlatformScopeNames(platform, [
        { projectId: "project-a", projectVersionId: "version-a" },
      ]),
    ).resolves.toEqual([
      {
        projectId: "project-a",
        projectName: "Gateway",
        projectVersionId: "version-a",
        projectVersionName: "2.4.0",
      },
    ]);
    expect(projectReads.count).toBe(1);
    expect(versionReads.count).toBe(1);
  });

  it("returns cached identifiers on its deadline even if a transport ignores abort", async () => {
    const hanging = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<RemotePage<Record<string, Json>>>>(
              () => {},
            ),
        };
      },
    };
    const platform = {
      listProjects: () => hanging,
      listVersions: () => hanging,
    } satisfies Pick<PlatformClient, "listProjects" | "listVersions">;

    await expect(
      resolvePlatformScopeNames(
        platform,
        [{ projectId: "project-a", projectVersionId: "version-a" }],
        10,
      ),
    ).resolves.toEqual([
      {
        projectId: "project-a",
        projectName: null,
        projectVersionId: "version-a",
        projectVersionName: null,
      },
    ]);
  });
});
