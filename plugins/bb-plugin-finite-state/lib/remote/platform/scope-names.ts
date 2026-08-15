import type { Json, PlatformClient, RemotePage } from "../types.js";

export interface PlatformScopeNameInput {
  projectId: string;
  projectVersionId: string;
}

export interface PlatformScopeName extends PlatformScopeNameInput {
  projectName: string | null;
  projectVersionName: string | null;
}

async function firstPage(
  pages: AsyncIterable<RemotePage<Record<string, Json>>>,
): Promise<readonly Record<string, Json>[]> {
  const iterator = pages[Symbol.asyncIterator]();
  try {
    const page = await iterator.next();
    return page.done ? [] : page.value.items;
  } finally {
    await iterator.return?.();
  }
}

function namesById(
  rows: readonly Record<string, Json>[],
  wanted: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const id = row["id"];
    const name = row["name"];
    if (
      typeof id === "string" &&
      wanted.has(id) &&
      typeof name === "string" &&
      name.length > 0
    ) {
      names.set(id, name);
    }
  }
  return names;
}

/**
 * Best-effort display-name enrichment for already cached scopes.
 *
 * The lookup is deliberately bounded to one Platform page plus one page for
 * each cached project, and is timeboxed. Callers must render their local cache
 * result before awaiting this optional enrichment.
 */
export async function resolvePlatformScopeNames(
  platform: Pick<PlatformClient, "listProjects" | "listVersions">,
  scopes: readonly PlatformScopeNameInput[],
  timeoutMs = 1_500,
): Promise<PlatformScopeName[]> {
  const unavailable = () =>
    scopes.map((scope) => ({
      ...scope,
      projectName: null,
      projectVersionName: null,
    }));
  if (scopes.length === 0) return [];
  const controller = new AbortController();
  const projectIds = new Set(scopes.map((scope) => scope.projectId));
  const versionIdsByProject = new Map<string, Set<string>>();
  for (const scope of scopes) {
    const ids = versionIdsByProject.get(scope.projectId) ?? new Set<string>();
    ids.add(scope.projectVersionId);
    versionIdsByProject.set(scope.projectId, ids);
  }

  const lookup = async (): Promise<PlatformScopeName[]> => {
    const projectNamesPromise = firstPage(
      platform.listProjects({ pageSize: 1_000 }, { signal: controller.signal }),
    )
      .then((rows) => namesById(rows, projectIds))
      .catch(() => new Map<string, string>());
    const versionNameEntries = await Promise.all(
      [...versionIdsByProject].map(async ([projectId, wanted]) => {
        const rows = await firstPage(
          platform.listVersions(
            projectId,
            { pageSize: 1_000 },
            { signal: controller.signal },
          ),
        ).catch(() => []);
        return [projectId, namesById(rows, wanted)] as const;
      }),
    );
    const projectNames = await projectNamesPromise;
    const versionNames = new Map(versionNameEntries);
    return scopes.map((scope) => ({
      ...scope,
      projectName: projectNames.get(scope.projectId) ?? null,
      projectVersionName:
        versionNames.get(scope.projectId)?.get(scope.projectVersionId) ?? null,
    }));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PlatformScopeName[]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(unavailable());
    }, timeoutMs);
  });
  try {
    return await Promise.race([lookup(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
