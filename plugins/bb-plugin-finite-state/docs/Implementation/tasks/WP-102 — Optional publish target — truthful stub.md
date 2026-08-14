# WP-102 — Optional `publish` target — truthful stub

**Lane:** L2 Sync engine · **Spec:** AUTHORITY near-term item 5 · ADR addendum · **Effort:** 0.5 d · **Status:** unassigned (DRAFT — owner review required before dispatch)
**Depends on:** WP-99, WP-100 · **Blocks:** nothing (GraphClient facade is a future amendment, not part of this set)
**Produces a FROZEN artifact:** no

## Files you own

```
plugins/bb-plugin-finite-state/lanes/sync/publish/publish-stub.ts
plugins/bb-plugin-finite-state/lanes/sync/publish/publish-stub.test.ts
```

Plus surgical registration in `lanes/sync/cli.ts` (list the exact hunk in your PR description).

## Files you must not touch

The four frozen interfaces, both composition roots, and the kept-frozen AS export surfaces. Do not add a `GraphClient`, a Platform write route, or any feature detection against live services — the facade is explicitly a future amendment.

## Context

Owner ruling 2026-08-14, near-term item 5: "Optional `publish` to Graph — stub until Platform has TARA entities." The destination for published contract entities will eventually be the Platform Graph, but Platform has no TARA entities yet. The product needs the verb to exist and tell the truth: publish is not available yet, nothing was sent, here is where it will go. A stub that lies (pretends success) or that quietly probes the network would be worse than no verb.

## What to build

1. **The verb.** Register `publish` on the sync CLI surface as human-only. Invocation returns a structured, truthful outcome: target `platform-graph`, status `unavailable-stub`, explanation that Platform does not yet host TARA entities, and a pointer to the AUTHORITY doc.
2. **Zero side effects.** No network call, no settings read beyond what verb registration itself requires, no file or projection write, no queue entry.
3. **Surface discipline.** Not exposed as an agent tool; not added to the Sync panel push flow (kept-frozen); a Sync panel affordance may name the verb only as inert documentation text, not a button that fires it.

## Interface contract

```ts
export interface PublishStubResult {
  readonly target: "platform-graph";
  readonly status: "unavailable-stub";
  readonly message: string;
}
```

## Acceptance criteria

- [ ] `publish` returns the structured stub outcome; a network guard asserts zero remote calls and a filesystem guard asserts zero writes.
- [ ] The verb is absent from agent tool registrations (guard test against the real registration surface).
- [ ] Kept-frozen AS export surfaces are untouched by the diff (reviewer verifies path set).
- [ ] The stub message names the future destination and cites the AUTHORITY doc, so no operator mistakes the stub for a broken feature.
- [ ] No acceptance criterion requires an AS round-trip or live Platform access.

## Test plan

`publish-stub.test.ts`: structured outcome shape, zero-side-effect guards, agent-surface exclusion.

## Do not

- Do not fake success or partial success.
- Do not probe Platform for Graph availability.
- Do not scaffold "future" GraphClient interfaces; the amendment will define them.

## Open questions

- None. The scope is intentionally minimal; anything more belongs to the GraphClient facade amendment.
