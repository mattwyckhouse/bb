# WP-99 — Repo contract load on checkout (YAML → SQLite projection)

**Lane:** L2 Sync engine · **Spec:** AUTHORITY near-term item 1 · SPEC 00 §14 · SPEC 01 §3 · **Effort:** 3 d · **Status:** unassigned (DRAFT — owner review required before dispatch)
**Depends on:** WP-16, WP-17 · **Blocks:** WP-100, WP-101, WP-102
**Produces a FROZEN artifact:** no

## Files you own

```
plugins/bb-plugin-finite-state/lib/contract-load/loader.ts
plugins/bb-plugin-finite-state/lib/contract-load/projection-key.ts
plugins/bb-plugin-finite-state/lib/contract-load/loader.test.ts
plugins/bb-plugin-finite-state/lib/contract-load/projection-key.test.ts
plugins/bb-plugin-finite-state/lib/contract-load/index.ts
```

## Files you must not touch

The four frozen interfaces (`shared/contract.ts`, `lib/store/schema.ts`, `lib/sync/registry.ts`, `lib/remote/types.ts`), both composition roots, the kept-frozen AS export surfaces (`lanes/sync/push/**`, `syncPush` RPCs, Sync panel push controls), and `lanes/sync/pull/**`. If the store schema cannot represent the projection you need, STOP and write an amendment; do not edit the schema.

## Context

Owner ruling 2026-08-14 (AUTHORITY doc): Git holds the contract. `.fs/` YAML in the repo checkout is the truth surface; SQLite is a disposable projection of it. Today the projection is populated by sync `pull`; a fresh checkout with committed `.fs/` but no remote configured renders empty panels. This WP is the keystone of the near-term sequence: on plugin activation and on checkout movement, the projection must rebuild from the committed YAML — fully offline, no Assurance Studio, no Platform.

## What to build

1. **Projection key.** Compute a rebuild key from the git HEAD commit id plus a content hash over the `.fs/**` tree (so dirty-worktree edits are captured, not just commits). Persist the key alongside the projection.
2. **Loader.** On plugin activation and on detected checkout movement (HEAD change or `.fs/` content change), compare keys. On mismatch, rebuild the SQLite projection from `.fs/**` YAML through the existing serializers and store APIs. On match, skip — activation on an unchanged checkout must do no YAML parsing beyond the hash pass.
3. **Disposability.** Deleting the SQLite database file and reloading must reproduce identical projection state. The loader never writes YAML; agents and humans author YAML, never SQLite.
4. **Offline guarantee.** The load path must make zero remote calls. It must not read remote settings, and it must succeed with no Assurance Studio or Platform connection configured.
5. **Diagnostics.** Malformed YAML files are reported per-file with path and parse error; a bad file skips that entity and surfaces a visible diagnostic — it must not abort the whole load or crash activation.

## Interface contract

```ts
export interface ContractLoadResult {
  readonly key: { headCommit: string; contentHash: string };
  readonly rebuilt: boolean;
  readonly entityCounts: Readonly<Record<string, number>>;
  readonly diagnostics: readonly { path: string; message: string }[];
}

export function loadRepoContract(
  workspaceRoot: string,
  store: FsStore,
): Promise<ContractLoadResult>;
```

## Acceptance criteria

- [ ] Fresh checkout with committed `.fs/` and **no remote settings configured**: plugin activates, projection builds, requirement/TARA/triage surfaces render populated. A network guard in the test asserts zero remote calls.
- [ ] Bench and requirements surfaces light up from `.fs/requirements` with Assurance Studio unconfigured (the FS-201-class rewrite made binding).
- [ ] Key semantics proven by test: unchanged HEAD + unchanged content → no rebuild; branch switch → rebuild; uncommitted `.fs/` edit → rebuild.
- [ ] Deleting the SQLite file and reloading yields a projection identical to the pre-delete golden snapshot.
- [ ] Malformed YAML in one file produces a per-file diagnostic and does not block loading the remaining entities.
- [ ] No acceptance path, test, or beat requires an Assurance Studio round-trip.

## Test plan

`lib/contract-load/loader.test.ts`: fixture repo (disposable git dir) with committed `.fs/` corpus; assert build, skip, and invalidation across HEAD move and dirty edit; golden-compare after projection delete; error path with one corrupt YAML file. `projection-key.test.ts`: key stability and sensitivity (ordering, file rename, content-only change).

## Do not

- Do not add any remote fallback ("if projection empty, try pull") — offline is the contract.
- Do not write YAML from this path.
- Do not edit frozen interfaces; amendment + STOP if blocked.
- Do not rewrite `RemoteServices` or touch kept-frozen AS export surfaces.

## Open questions

- Whether activation-time hashing of large `.fs/` trees needs a mtime-based fast path — measure first, optimize only with evidence.
