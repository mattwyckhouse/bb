---
name: fs-sync
description: Sync status, plans, conflicts, orphans, and stale or offline base snapshots in a Finite State workspace. Use when the user asks for a sync plan, conflict etiquette, orphaned YAML, stale-after-pull, or whether local intent is ready for human review — not for findings, requirements, or firmware bytes.
---

# Purpose and when to use

Use this skill to inspect local versus upstream sync state and to show what a human would review. `fs_sync_status` and `fs_sync_plan` are read tools. Plan may refresh upstream tuples for conflict detection; it never mutates upstream.

Root skill (`fs-finite-state`) holds the iron rule. Git `.fs/` YAML is the contract truth; push to Assurance Studio is a human-gated export, not an agent verb.

## Identity first

Plan and status rows are keyed by the same stable entity keys as the authored files (slugs, finding stable keys, `HBOM-*`). Talk about those keys, not remote UUIDs. The plan directive id is the persisted plan ULID from `fs_sync_plan`.

## Workflow

1. Call `fs_sync_status` with `projectId` and optional `projectVersionId` / `surface` for counts and keys: local, upstream, conflict, orphan.
2. Call `fs_sync_plan` with the same scope plus optional `cursor` / `limit` (default 50, max 200). It returns an ordered changeset: creates, updates, deletes, conflicts, orphans, validation errors, and blast radius, plus an id for `::fs-plan{id}`.
3. If the plan refresh times out or is offline, the result degrades to the last-pulled base with `stale: true` and a `basePulledAt`. Report that honestly — push-time state may differ.
4. If the plan shows conflicts, report both sides and stop. Conflict choice (`take-ours` / `take-theirs` / edited) is a human gate. Do not invent trial-apply, TARA head-token, or `stale_tara_state` workflows; those are parked.
5. Orphans are retained YAML with no current remote match. Do not delete them unless a human asks through the human-gated orphan path.

Filter tighter rather than paging longer.

## Evidence and review expectations

Status and plan are evidence of local intent versus last-seen upstream, not proof that anything reached a remote. After writes on other surfaces, this is the check: summarize dirty paths, show `::fs-plan{id}`, and stop for human review. The human may export; the agent does not.

## Tools and native-file boundaries

- `fs_sync_status` — local / upstream / conflict / orphan summary. `server: none`.
- `fs_sync_plan` — read-only plan with optional network refresh. Render with `::fs-plan{id}`.

Authored YAML is readable with native file tools. Do not duplicate the live CLI tree; `bb finite-state status` and `bb finite-state plan` exist at HEAD and share this mental model. There is no agent-callable push.

## What to render

- A proposal ready for the human → `::fs-plan{id="<planId>"}`
- Do not paste the full changeset when the directive is enough.

## Never

- Never call `fs_sync_push`. It is not registered and must not be treated as a command.
- Never resolve a conflict, overwrite the other author's YAML to "win," or claim a plan was pushed or applied.
- Never hide `stale: true`. A stale plan is a warning, not a green light.

---
