# WP-101 — Stage-0 Code Assurance binding against `.fs/requirements`

**Lane:** integration · **Spec:** AUTHORITY near-term item 4 · SPEC 00 §14 · **Effort:** 2 d · **Status:** unassigned (DRAFT — owner review required before dispatch)
**Depends on:** WP-99 · **Blocks:** nothing in this set
**Produces a FROZEN artifact:** no

## Files you own

```
plugins/bb-plugin-finite-state/test/e2e/code-assurance/stage0-binding.test.ts
plugins/bb-plugin-finite-state/test/e2e/code-assurance/fixture-repo/
plugins/bb-plugin-finite-state/lib/contract-load/requirements-export.ts
plugins/bb-plugin-finite-state/lib/contract-load/requirements-export.test.ts
```

## Files you must not touch

The four frozen interfaces, both composition roots, kept-frozen AS export surfaces, and any Platform Graph publish path (none exists; do not create one — that is WP-102's stub and a future amendment).

## Context

Owner ruling 2026-08-14, near-term item 4: prove stage 0 can bind `fs-cli` / SEI Code Assurance against `.fs/requirements` — explicitly **not blocked on Graph publish**. The claim to prove: a repo whose committed `.fs/requirements/**` YAML is the only requirements source provides everything Code Assurance binding needs — stable requirement keys and EARS text — with Assurance Studio unconfigured and no published Graph anywhere. This WP is a proof with a small adapter, not a product surface.

## What to build

1. **Requirements binding export.** A read-side adapter over the WP-99 projection that exposes requirements in the shape the stage-0 Code Assurance flow consumes: stable key, EARS text, status, and source-file provenance for each requirement in `.fs/requirements/**`.
2. **Fixture repo.** A committed fixture checkout containing a realistic `.fs/requirements` corpus (reuse the golden-loop seed corpus where possible rather than inventing a new one).
3. **Binding proof harness.** An e2e test that: loads the fixture repo offline through WP-99, produces the binding export, drives the same consumption path `fs-cli` / SEI use (or the closest in-repo equivalent, documented in the test header), and asserts every requirement binds by stable key with its EARS text intact.
4. **Stability proof.** Rename a requirement's file and re-run: binding follows the stable key, not the path. Edit EARS text and re-run: the key holds, the text updates.
5. **Negative path.** A requirement with a malformed or duplicate stable key is reported as a binding diagnostic naming the offending file; it does not crash the harness or silently drop rows.

## Interface contract

```ts
export interface RequirementBindingRow {
  readonly stableKey: string;
  readonly earsText: string;
  readonly status: string;
  readonly sourcePath: string;
}

export function exportRequirementBindings(
  store: FsStore,
): readonly RequirementBindingRow[];
```

## Acceptance criteria

- [ ] The binding proof passes fully offline: no Assurance Studio configuration, no Platform Graph, no network (asserted by guard).
- [ ] Every requirement in the fixture's `.fs/requirements/**` binds by stable key with EARS text intact.
- [ ] File rename does not break binding (stable key holds); text edit updates the bound text under the same key.
- [ ] Malformed/duplicate stable keys yield named diagnostics, not crashes or silent drops.
- [ ] The test header documents exactly which consumption path stands in for `fs-cli` / SEI, so the owner can judge the fidelity of the proof.
- [ ] No acceptance criterion requires an AS round-trip or a Graph publish.

## Test plan

`stage0-binding.test.ts` covers the proof harness including rename/edit stability and the malformed-key error path; `requirements-export.test.ts` covers the adapter against a minimal in-memory projection.

## Do not

- Do not publish anything anywhere; this is read-side proof only.
- Do not fork a second requirements parser; consume the WP-99 projection.
- Do not gate any assertion on live Finite State services.

## Open questions

- Whether the stand-in consumption path is faithful enough to `fs-cli` / SEI internals, or whether the owner wants a live `fs-cli` invocation pinned in CI later (out of scope here).
