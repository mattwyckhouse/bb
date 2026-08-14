---
name: fs-triage
description: Inspect and explain Finite State findings, VEX triage, version drift, stale decisions, conflicts, orphaned decisions, and vendor VEX proposals. Use whenever work involves CVEs, findings, local triage YAML, reattachment after a pull, drift reports, or supplier VEX—even if the user does not name Finite State.
---

# Finite State findings and drift

Treat the local `.fs/triage/` overlay as durable authored intent. Platform finding UUIDs are ephemeral, so reason from the stable component-and-CVE identity and the drift report rather than comparing UUIDs.

## Read drift

Use the generated `plugin-commands` skill for the exact current CLI syntax. The relevant read is `bb finite-state triage drift report` with an explicit Platform project and project-version scope. Reports are cached, bounded, and paged; follow `nextCursor` when the requested answer needs more than the first page.

Interpret the states as follows:

- `reattached_noop`: canonical identity resolved and the server tuple already matches local intent.
- `reapply`: identity resolved but server carry-forward missed or differs without a three-way conflict.
- `stale`: version-sensitive evidence must be reviewed again.
- `orphaned`: no current component/CVE match exists; the YAML is intentionally retained.
- `conflict`: local and server tuples both diverged from the recorded base.
- `needs_completion`: proposal data is incomplete and cannot enter plan/push.

Report `runId`, `createdAt`, and `unclassifiedCount` with conclusions so the user can judge freshness. A nonzero unclassified count means the persisted report does not fully describe the current overlay index.

## Human boundaries

Supplier VEX is proposal data, not a decision. Never fill an omitted justification, response, reason, scope, or evidence. Incomplete `NOT_AFFECTED` proposals remain `needs_completion`; unmatched proposals remain `match:none` for a later pull.

Do not request or invent an agent tool for vendor overwrite or orphan pruning. `--overwrite` exists only on the human CLI/panel import affordance. Pruning is a local YAML deletion that requires a fresh base-state digest, an explicit selection, and human confirmation in the panel or CLI; the human surface also supports a dry-run preview. When the user asks an agent to perform either operation, read and explain the report, then direct the user to the corresponding human surface.

Normal agent-assisted triage writes still use the registered triage tools and strict decision validation. They never push upstream; review and push remain human-controlled surfaces.
