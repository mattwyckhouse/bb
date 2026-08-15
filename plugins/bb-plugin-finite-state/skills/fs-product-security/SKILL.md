---
name: fs-product-security
description: TARA threat models, EARS requirements, verification matrix, and THREAT/REQ/COMP slugs in a Finite State workspace. Use to author requirements, inspect the canvas, run a mapped verification, or reason about traces — not for CVE VEX, SBOM licenses, or HBOM cell acceptance.
---

# Purpose and when to use

The authored model lives as VERSIONED YAML under `product-security/`. Edit it locally. Git is the contract truth. Assurance Studio import is seed only. `fs_requirement_write` is local YAML; `fs_verification_run` queues a mapped check and does not itself mark a requirement verified.

## Identity first

Reference by slug, never UUID, and never reuse a slug: `THREAT-*`, `COMP-*`, `ZONE-*`, `FLOW-*`, `REQ-*`, `CHK-*`, `MIT-*`. Requirement writes must use `reqId` matching `REQ-[A-Za-z0-9][A-Za-z0-9-]*`. Preserve `req_id` verbatim when converting seed material; copy the original text into `source_description`.

File map (compact):

- VERSIONED: `product-security/architecture/{components,zones,dataflows,assets}/`, `product-security/threats/`, `product-security/mitigations/`, `product-security/requirements/`
- local-only VERSIONED: `product-security/layout/canvas.json`
- OVERLAY: `.fs/links/`, `.fs/verification/checks/`, `.fs/attack-paths/`

## Workflow

1. Query with `fs_tara_query` (`projectId`, `kind`, optional `projectVersionId` / `filter` / paging). Owner path runs `threat`, `component`, `zone`, `dataflow`, `asset`, `requirement`, `verification`, and `trace`. `kind: "trace"` requires `filter.requirementId` (`REQ-…`) or the tool returns `not_found`. `attack_path` and `clause` return `unsupported_kind`. Unresolved YAML⋈cache links are reported, never dropped.
2. Convert seed material with `fs_ears_convert`: `action: "bundle"` is cache-served (last pull; not a live AS call); `action: "validate"` runs gates 1–2 on paths and never writes.
3. Write one requirement with `fs_requirement_write` `{ reqId, yaml, expectedHash? }`. `yaml` is a parsed object (`schema: fs-requirement/v1`), not a string. Gates 1–2 are all-or-nothing. Gate 3 stays pending human diff review even after a successful write.
4. To change verification evidence, call `fs_verification_run` `{ requirement, tier?, check? }` (`tier`: `static` | `emulation` | `hil` | `manual` | `hardware`) and wait. The tool returns a durable `job_id` with status `queued`. Queued is not passed. Refetch via `fs_tara_query { kind: "verification" }`.
5. Cross-links: grep the firmware mount, cite exact paths into `.fs/links/firmware.yaml`; take purls from `fs_sbom_query` into `.fs/links/sbom.yaml`. Those overlay files are local intent.
6. If `fs_sync_plan` reports TARA or requirement conflicts, stop. Do not attempt trial-apply or head-token recovery.

EARS six-pattern table (parts.system and parts.response always required):

| Cue in the source      | Pattern             | Extra required parts                                          |
| ---------------------- | ------------------- | ------------------------------------------------------------- |
| Always-true obligation | `ubiquitous`        | none                                                          |
| WHEN / trigger         | `event_driven`      | `trigger`                                                     |
| WHILE / state          | `state_driven`      | `state`                                                       |
| IF/THEN undesired      | `unwanted_behavior` | `trigger`                                                     |
| WHERE / feature-gated  | `optional_feature`  | `feature`                                                     |
| Two or more conditions | `complex`           | at least two of `feature`, `precondition`, `state`, `trigger` |

Parts must match pattern. Copy `pass_criteria` / `fail_criteria` verbatim from the mapped check. `check: null` if there is no check yet. Never invent ids.

## Evidence and review expectations

Never write server-owned or derived fields, including `verification_status`, `verification_summary`, `verification_last_run_at`, `verification_evidence_ids`, `project_id`, `organization_id`, `source`, `created_by_agent`, `model_id`, `source_evidence_ids`, `source_chat_run_id`, `created_by_user_id`, `human_edited*`, `reviewed*`, `needs_reanalysis`, `stale_reason`, `embedding`, `created_at`, `updated_at`, `display_code`, `assurance_level`, or any `review_*` / `ai_*` / `processing_*` / `*_count` key. Workflow `status` (`draft` | `approved` | `implemented` | `verified`) is not a substitute for run evidence.

After writes: summarize paths and Gate 3 pending; point at the diff; call `fs_sync_plan`; emit `::fs-req{id}` or `::fs-threat{id}`; stop for human review.

## Tools and native-file boundaries

- `fs_tara_query` — model + cache; slugs for `::fs-threat{id}` / `::fs-canvas{focus}`.
- `fs_ears_convert` — bundle or validate only.
- `fs_requirement_write` — one YAML object; CAS via `expectedHash`.
- `fs_verification_run` — ACTION; queues, does not attest.
- Native file tools for VERSIONED/OVERLAY YAML. Do not duplicate the CLI tree; WP-64 surface verbs are out of scope.

## What to render

- Threat → `::fs-threat{id="THREAT-22"}`
- Architecture context → `::fs-canvas{focus="COMP-httpd" highlight="THREAT-22"}`
- Requirement → `::fs-req{id="REQ-104"}`
- Coverage slice → `::fs-matrix{filter="unproven"}`
- Mentions → `@REQ-104`, `@THREAT-22`, `@CHK-sig-verify`

## Never

- Never call `fs_sync_push`, never push the model, never resolve conflicts.
- Never write `verification_status` or claim a requirement is verified in prose. Emit the latest results and let them speak.
- Never invent slugs or paraphrase pass/fail criteria.

---
