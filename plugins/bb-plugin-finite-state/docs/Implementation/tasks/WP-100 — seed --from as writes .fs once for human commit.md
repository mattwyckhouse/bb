# WP-100 — `seed --from as` writes `.fs/` once for human commit

**Lane:** L2 Sync engine · **Spec:** AUTHORITY near-term item 2 · SPEC 01 §3/§5 · **Effort:** 2 d · **Status:** unassigned (DRAFT — owner review required before dispatch)
**Depends on:** WP-99 · **Blocks:** WP-102
**Produces a FROZEN artifact:** no

## Files you own

```
plugins/bb-plugin-finite-state/lanes/sync/seed/seed-from-as.ts
plugins/bb-plugin-finite-state/lanes/sync/seed/seed-from-as.test.ts
plugins/bb-plugin-finite-state/lanes/sync/seed/index.ts
```

Plus surgical wiring in `lanes/sync/cli.ts` and `lanes/sync/rpc.ts` to register the verb (list the exact hunks in your PR description).

## Files you must not touch

The four frozen interfaces, both composition roots, the kept-frozen AS export surfaces (`lanes/sync/push/**`, `syncPush` RPCs, Sync panel push controls), and the FS-198 picker's binding semantics — the picker is frozen as **seed UX** and must not grow into a permanent second-home binding.

## Context

Owner ruling 2026-08-14: Assurance Studio is how we import last year's model — not where this year's work becomes real. `seed --from as` is the one-shot import: select an AS project through the existing FS-198 picker, serialize its entities into `.fs/**` YAML in the working tree, and stop. The human reviews the git diff and commits. After that, WP-99's loader owns the projection and AS is optional forever.

## What to build

1. **The verb.** `seed --from as` (CLI) and the equivalent human-only RPC behind the Sync panel: resolve the AS project binding via the FS-198 picker, fetch entities through the existing AS client, serialize through the existing serializers to `.fs/**` files in the worktree.
2. **Write-once discipline.** Seed writes files and stops. No auto-commit, no SQLite writes (the projection updates via WP-99 once the files exist), no remote writes of any kind.
3. **Non-empty guard.** Seeding into a worktree whose `.fs/` already has content requires an explicit human confirmation and never silently overwrites `human_edited` content. The confirmation surface follows the established split: the panel exposes the choice, the CLI verb requires an explicit flag typed by the human, and agent tools do not expose the verb at all.
4. **Provenance.** Seeded files carry the established provenance stamp (source project, timestamp, run id) so a later reader can tell seeded baseline from authored work.
5. **AS-unconfigured behavior.** With no AS connection configured, the verb reports actionable guidance and exits cleanly; nothing else in the plugin degrades.

## Interface contract

```ts
export interface SeedFromAsResult {
  readonly projectId: string;
  readonly filesWritten: readonly string[];
  readonly skippedHumanEdited: readonly string[];
  readonly outcome: "written" | "refused-nonempty" | "as-unconfigured";
}
```

## Acceptance criteria

- [ ] Against the mock AS remote, `seed --from as` writes a complete `.fs/**` tree; `git status` shows only untracked/modified YAML; nothing is committed and no remote write occurs.
- [ ] After a human commit of the seeded tree, a fresh checkout renders fully populated surfaces through WP-99's loader with AS unconfigured — the seed is needed exactly once.
- [ ] Re-running seed over a non-empty `.fs/` without confirmation returns `refused-nonempty` and writes nothing; with human confirmation it overwrites non-human-edited files and reports `skippedHumanEdited` for the rest.
- [ ] The verb is absent from agent tool registrations (guard test against the real registration surface, not a snapshot).
- [ ] With AS unconfigured the verb returns `as-unconfigured` guidance and every other surface keeps working.
- [ ] No acceptance criterion outside the seed verb itself touches AS; seed tests run against the mock remote only.

## Test plan

`seed-from-as.test.ts`: happy path against mock AS (tree written, nothing committed, provenance stamped); non-empty refusal and confirmed overwrite with `human_edited` preservation; AS-unconfigured guidance path; agent-surface exclusion guard.

## Do not

- Do not add periodic or automatic re-seed; one shot, human-invoked.
- Do not extend the FS-198 picker beyond project selection for seeding.
- Do not touch push/export code paths.
- Do not invent a new serializer; reuse the existing ones or STOP.

## Open questions

- Whether seed should offer per-entity-kind selection in v1 or always import the full project (draft assumes full project; owner may narrow).
