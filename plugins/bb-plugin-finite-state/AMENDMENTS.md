# Finite State contract amendments

Frozen contracts may change only through an amendment entry approved by the contract owner and one affected-lane reviewer. Pre-freeze architecture corrections retain their accepted `A-*` identifiers; post-freeze contract changes use `AMD-*`. CI, not an implementation lane, updates baseline hashes after approval.

Each amendment must record:

- identifier and status;
- old and new artifact hashes;
- reason and migration plan;
- affected work packages and gates;
- approver/reviewer identities;
- broadcast and merge commits.

No amendment is implied by an implementation task, code comment, or local workaround.

## Guard entry format

`check-frozen-artifacts.mjs --accept <id>` accepts only an already-approved
`A-*` or `AMD-*` entry with these exact fields directly below its `###` heading.
The artifact list must name exactly the frozen paths (or plugin `package.json`)
whose baseline changes. `Contract version` is the numeric `CONTRACT_VERSION`
when `shared/contract.ts` changes, otherwise `n/a`. This intentionally small,
line-oriented format keeps the approval visible in review while making a prose
edit unable to bypass the guard.

The WP-09 bootstrap records SHA-256 provenance for all listed interfaces, but
only activates the two composition roots. The currently unresolved WP-03/04/05/06
and WP-08 entries remain `active: false`; their owning, independently reviewed
merge must change the artifact and run `--accept <AMD-id>` to activate its hash.
Inactive entries are deliberately not frozen yet.

```md
### AMD-0001 — Short title

- Status: approved
- Artifacts:
  - `plugins/bb-plugin-finite-state/shared/contract.ts`
- Contract version: 2
```

## Approved amendments

### A-000 — Direct APIs and optional Forge compute

- Status: approved
- Merge status: merged
- Artifacts:
  - `plugins/bb-plugin-finite-state/server.ts`
  - `plugins/bb-plugin-finite-state/app.tsx`
  - `plugins/bb-plugin-finite-state/shared/contract.ts`
  - `plugins/bb-plugin-finite-state/lib/store/schema.ts`
  - `plugins/bb-plugin-finite-state/lib/sync/registry.ts`
  - `plugins/bb-plugin-finite-state/lib/remote/types.ts`
  - `plugins/bb-plugin-finite-state/test/mock-remote/fixtures/**`
  - `plugins/bb-plugin-finite-state/package.json`
- Contract version: 0
- Prior artifact hashes: pre-freeze; no contract baseline existed
- New artifact hashes: `BASELINE.json` records the approved spec and vendored-input hashes
- Reason: replace Forge-as-data-gateway with direct typed Platform and Assurance Studio REST while retaining only unique Forge compute
- Migration: update the handoff, ADR, Product Specs, remote contracts, mocks, registry ownership, and all affected WPs before implementation dispatch
- Affected WPs and gates: WP-01, WP-03–06, WP-10–19, WP-22, WP-29, WP-40, WP-43, WP-50, WP-64; G0–G6
- Contract owner: Matt Wyckhouse (product-owner approval in the coordinating thread)
- Affected-lane reviewer: independent agent thread `thr_ib9at8u34a`
- Approved specification commit: `3e37cae40405f6857d6ff1f6f628baff134d8436`
- Merge commit: `b18f9878bc6c0b183603885687178480df56b309`
- Broadcast commit: `4f5431306245d2aef2abaa6aac342d947c780bdf` (initial target-repository corpus import)
- Result: Platform and Assurance Studio are direct typed REST data planes. Forge is nullable and restricted to the checksummed compute manifest. `prepareFirmwareRoot` is deliberately unresolved and must be removed or proven before WP-06 freezes.

### A-001 — Declare the repo-pinned Zod runtime dependency

- Status: approved
- Artifacts:
  - `plugins/bb-plugin-finite-state/package.json`
- Contract version: n/a
- Prior artifact hashes:
  - `plugins/bb-plugin-finite-state/package.json`: `191f9e51eb84fa5e049a1cad9c4c719660a56cc2386dc8a2d00ad3f887ca545d`
  - `pnpm-lock.yaml`: `b99026a911e4d6cfff34c5a1acabd179f0d2923111f32a01c5f9d67928b26b7e`
- New artifact hashes:
  - `plugins/bb-plugin-finite-state/package.json`: `41b3577a88829fef3daf24869eb11572ebba358c9076a1de738798ef0762c0e0`
  - `pnpm-lock.yaml`: `dbeb4f897f85ff24d3129ce038814fd53818d1995ba36b948101559c91028d5c`
- Reason: WP-03 requires a runtime Zod import, but the plugin package cannot resolve Zod under an isolated Node 22.19 workspace install unless it declares the dependency directly. The repository override already pins Zod to 4.3.6.
- Migration: declare `zod` `^4.3.6` in the plugin runtime dependencies and add only that dependency to the finite-state lockfile importer, reusing the existing `zod@4.3.6` package resolution. No source contract, composition root, or product behavior changes.
- Affected WPs and gates: WP-03 (FS-17) and WP-09 dependency-freeze checks; Node 22.19 frozen install and the scoped finite-state typecheck/test/lint/build gate
- Contract owner: Matt Wyckhouse (task authority)
- Affected-lane reviewer: independent review approved before PR #7 merge
- Implementation base commit: `ba28401a45b31dd1e907a043138207505fb01a4f`
- Merge commit: `ad2a96b09b063ab8c8b9f50484d8f6a5f98d9210`
- Broadcast commit: `ad2a96b09b063ab8c8b9f50484d8f6a5f98d9210`
- Result: merged to `finite-state/integration`. The plugin resolves the repo-pinned Zod 4.3.6 runtime directly, while the lockfile retains every pre-existing importer and package resolution unchanged.

## Pending amendments

None.
