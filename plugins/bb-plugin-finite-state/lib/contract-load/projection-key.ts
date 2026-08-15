import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CONTRACT_ROOTS = [".fs", "product-security"] as const;
export const REPO_LOCAL_PROJECT_ID_PREFIX = "fs-local-repo:";

export interface ProjectionKey {
  readonly headCommit: string;
  readonly contentHash: string;
}

export interface RepoContractIdentity {
  readonly canonicalRoot: string;
  readonly repositoryDigest: string;
  readonly projectId: string;
  readonly projectVersionId: string;
}

interface TreeEntry {
  readonly kind: "directory" | "file" | "other" | "symlink";
  readonly path: string;
  readonly bytes: Buffer;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function updateField(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update("\0");
}

async function walkTree(
  workspaceRoot: string,
  absolutePath: string,
  entries: TreeEntry[],
): Promise<void> {
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const path = portablePath(workspaceRoot, absolutePath);
  if (stat.isSymbolicLink()) {
    entries.push({
      kind: "symlink",
      path,
      bytes: Buffer.from(await readlink(absolutePath), "utf8"),
    });
    return;
  }
  if (stat.isDirectory()) {
    entries.push({ kind: "directory", path, bytes: Buffer.alloc(0) });
    const children = await readdir(absolutePath);
    for (const child of children.sort((left, right) =>
      left.localeCompare(right),
    )) {
      await walkTree(workspaceRoot, join(absolutePath, child), entries);
    }
    return;
  }
  if (stat.isFile()) {
    entries.push({ kind: "file", path, bytes: await readFile(absolutePath) });
    return;
  }
  entries.push({ kind: "other", path, bytes: Buffer.alloc(0) });
}

async function headCommit(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "rev-parse", "--verify", "HEAD"],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  const commit = stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error("Repository HEAD did not resolve to a commit id");
  }
  return commit;
}

export async function repoContractIdentity(
  workspaceRoot: string,
): Promise<RepoContractIdentity> {
  const canonicalRoot = await realpath(workspaceRoot);
  const repositoryDigest = createHash("sha256")
    .update(canonicalRoot, "utf8")
    .digest("hex");
  return {
    canonicalRoot,
    repositoryDigest,
    projectId: `${REPO_LOCAL_PROJECT_ID_PREFIX}${repositoryDigest}`,
    projectVersionId: `fs-local-checkout:${repositoryDigest}`,
  };
}

export async function computeProjectionKey(
  workspaceRoot: string,
): Promise<ProjectionKey> {
  const canonicalRoot = await realpath(workspaceRoot);
  const [commit, entries] = await Promise.all([
    headCommit(canonicalRoot),
    (async () => {
      const values: TreeEntry[] = [];
      for (const root of CONTRACT_ROOTS) {
        await walkTree(canonicalRoot, join(canonicalRoot, root), values);
      }
      return values.sort((left, right) => left.path.localeCompare(right.path));
    })(),
  ]);
  const hash = createHash("sha256");
  updateField(hash, "fs-repo-contract-tree/v1");
  for (const entry of entries) {
    updateField(hash, entry.kind);
    updateField(hash, entry.path);
    updateField(hash, entry.bytes);
  }
  return { headCommit: commit, contentHash: hash.digest("hex") };
}
