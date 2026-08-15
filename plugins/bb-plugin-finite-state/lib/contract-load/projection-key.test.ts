import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeProjectionKey,
  REPO_LOCAL_PROJECT_ID_PREFIX,
  repoContractIdentity,
} from "./projection-key.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fs-contract-key-"));
  roots.push(root);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Contract Loader Test");
  await git(root, "config", "user.email", "contract-loader@example.invalid");
  await mkdir(join(root, ".fs", "requirements"), { recursive: true });
  await mkdir(join(root, "product-security", "threats"), { recursive: true });
  await writeFile(
    join(root, ".fs", "requirements", "REQ-A.yaml"),
    "id: REQ-A\n",
  );
  await writeFile(
    join(root, "product-security", "threats", "threat-a.yaml"),
    "slug: threat-a\n",
  );
  await git(root, "add", ".fs", "product-security");
  await git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository contract projection key", () => {
  it("is stable and includes both tracked YAML roots in sorted path order", async () => {
    const root = await repository();
    const first = await computeProjectionKey(root);
    const second = await computeProjectionKey(root);
    expect(second).toEqual(first);

    await writeFile(
      join(root, "product-security", "threats", "threat-a.yaml"),
      "slug: threat-renamed\n",
    );
    const productSecurityEdit = await computeProjectionKey(root);
    expect(productSecurityEdit.headCommit).toBe(first.headCommit);
    expect(productSecurityEdit.contentHash).not.toBe(first.contentHash);
  });

  it("invalidates on a dirty .fs edit, path rename, and HEAD-only movement", async () => {
    const root = await repository();
    const clean = await computeProjectionKey(root);

    await writeFile(
      join(root, ".fs", "requirements", "REQ-A.yaml"),
      "id: REQ-A\npriority: P1\n",
    );
    const dirty = await computeProjectionKey(root);
    expect(dirty.headCommit).toBe(clean.headCommit);
    expect(dirty.contentHash).not.toBe(clean.contentHash);

    await git(root, "checkout", "--quiet", "--", ".fs/requirements/REQ-A.yaml");
    await git(
      root,
      "mv",
      ".fs/requirements/REQ-A.yaml",
      ".fs/requirements/REQ-B.yaml",
    );
    const renamed = await computeProjectionKey(root);
    expect(renamed.headCommit).toBe(clean.headCommit);
    expect(renamed.contentHash).not.toBe(clean.contentHash);

    await git(root, "reset", "--quiet", "--hard", "HEAD");
    await git(root, "checkout", "--quiet", "-b", "head-moved");
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "move head only",
    );
    const moved = await computeProjectionKey(root);
    expect(moved.headCommit).not.toBe(clean.headCommit);
    expect(moved.contentHash).toBe(clean.contentHash);
  });

  it("derives the synthetic identity only from the canonical checkout path", async () => {
    const root = await repository();
    const identity = await repoContractIdentity(join(root, "."));
    expect(identity.repositoryDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(identity.projectId).toBe(
      `${REPO_LOCAL_PROJECT_ID_PREFIX}${identity.repositoryDigest}`,
    );
    expect(identity.projectVersionId).toBe(
      `fs-local-checkout:${identity.repositoryDigest}`,
    );
  });
});
