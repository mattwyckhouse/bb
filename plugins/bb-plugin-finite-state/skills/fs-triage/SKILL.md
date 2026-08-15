---
name: fs-triage
description: Vulnerability findings, CVE, CVEs, VEX justification, reachability, false positives, KEV holdback, and firmware triage in a Finite State workspace. Use for VEX decisions, NOT_AFFECTED, policy dry-run, CODE_NOT_REACHABLE pins, and overlay intent — not for SBOM licenses, HBOM parts, or threat-model authoring.
---

# Purpose and when to use

Triage writes VEX decisions to the local `.fs/triage/` overlay. Updates are local YAML only. A human reviews the diff; the agent does not push.

## Identity first

Decisions key on the finding stable-key ladder from an `fs_findings_query` row, never on finding UUIDs.

1. **purl** tier when the row has a purl.
2. **name-group-version** when there is no purl.
3. **name-group-any-version** only when version is absent.

One key covers duplicate rows for that (component, CVE). If `fs_triage_set` returns `orphaned_key`, re-query — do not invent a replacement key.

Pin:

- `exact_version` — build-specific evidence. **Forced** for `CODE_NOT_REACHABLE`.
- `any_version` — protocol-level / `CODE_NOT_PRESENT` / vendor assertions that should follow the component. Never pair it with `CODE_NOT_REACHABLE`.
- When unsure, omit `pin` and take the tool default (`exact_version` when it must be forced).

## Workflow

1. Query with `fs_findings_query` (`projectId`, `version`, optional `component`, `cve`, `severity`, `reachability`, `kev`, `epss_gte`, `triage`, `finding_type`, `cursor`, `limit`). Rows return the stable `id`, scores, KEV, reachability, and local/server decision summaries. Refine filters rather than raising `limit` (default 50, max 200).
2. For routine unmatched findings, run `fs_triage_apply_policy` with `{ projectVersionId, dryRun: true }` first when the scope is large or unfamiliar, then without `dryRun` to write. Existing human, vendor, and manual decisions are skipped.
3. Policy returns `held` items (KEV always; incomplete data). Reason about each with `fs_triage_set`. Never relax a holdback by re-running policy.
4. `fs_triage_set` requires `projectVersionId`, `stableKey`, `status`, `reason` (≥12 chars), and `evidence`. `NOT_AFFECTED` requires a justification. Updates must pass `expectedHash` from a prior write or they fail `cas_mismatch`.
5. Check the overlay with `fs_sync_plan`. If it shows conflicts, report them — do not resolve.

Supplier VEX is proposal data. Incomplete `NOT_AFFECTED` proposals stay incomplete. Vendor overwrite is a panel-only human gate. If the user asks an agent to overwrite vendor decisions, read the preview if they already have one, explain it, and stop.

## Evidence and review expectations

Vocabulary (tool-validated):

- **Status (6):** `NOT_AFFECTED` · `EXPLOITABLE` · `IN_TRIAGE` · `FALSE_POSITIVE` · `RESOLVED` · `RESOLVED_WITH_PEDIGREE`
- **Justification (9, only with `NOT_AFFECTED`):** `CODE_NOT_PRESENT` · `CODE_NOT_REACHABLE` · `REQUIRES_CONFIGURATION` · `REQUIRES_DEPENDENCY` · `REQUIRES_ENVIRONMENT` · `PROTECTED_BY_COMPILER` · `PROTECTED_AT_RUNTIME` · `PROTECTED_AT_PERIMETER` · `PROTECTED_BY_MITIGATING_CONTROL`
- **Response (5):** `CAN_NOT_FIX` · `WILL_NOT_FIX` · `UPDATE` · `ROLLBACK` · `WORKAROUND_AVAILABLE`

Do not default to `CODE_NOT_REACHABLE` unless the row's reachability factors support it, and then pin `exact_version`. Quote the factor, config fact, or path in `evidence`. Durable reasoning belongs in that field, not only in chat.

After writes: summarize counts, holds, and notable calls; name the YAML paths and the diff; call `fs_sync_plan`; emit `::fs-triage-summary{id}` for a bulk run (or `::fs-finding{id}` for a single key); stop for human review.

## Tools and native-file boundaries

- `fs_findings_query` — CACHED findings; stable keys for `::fs-finding{id}`.
- `fs_triage_apply_policy` — evaluates `.fs/triage/policy.yaml`; `dryRun` only extra flag; `::fs-triage-summary{id}`.
- `fs_triage_set` — one overlay decision.
- `fs_sync_status` / `fs_sync_plan` — check work.

Read overlay YAML with native file tools when you need the full block. Do not duplicate the live CLI tree. Drift report, vendor-import apply, and orphan prune exist as human/CLI surfaces at HEAD; the agent does not use them to overwrite or prune.

## What to render

- One finding → `::fs-finding{id="<stableKey>"}` (or `cve=` + `purl=`)
- Bulk policy run → `::fs-triage-summary{id="<runId>"}`
- CVE in prose → `#CVE-2023-42364`

## Never

- Never call `fs_sync_push` or describe decisions as applied, pushed, or upstream.
- Never overwrite existing decisions, vendor VEX, or another author's block. Flag disagreement with both positions. The policy tool cannot expose an overwrite-existing flag.
- Never invent a stable key, skip evidence, or pair `CODE_NOT_REACHABLE` with `any_version`.

---
