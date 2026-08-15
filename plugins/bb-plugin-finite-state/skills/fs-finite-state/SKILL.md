---
name: fs-finite-state
description: Finite State workspace invariants — VERSIONED, CACHED, OVERLAY, and ACTION classes, Git as the contract truth, stable keys, and who may push. Use when the user asks how this workspace works, what an overlay is, whether an agent can push or attest, or what verified means.
---

# Purpose and when to use

This is the root Finite State skill. It holds the invariants that apply on every surface. Load a surface skill (`fs-sync`, `fs-triage`, `fs-product-security`, `fs-bom`, `fs-firmware`, `fs-bench`, `fs-docs`) for domain craft. Reserved later names, not in this tree: `fs-hardware`, `fs-bringup`, `fs-debug-bench`, `fs-citation`, `fs-porting`, `fs-instruments`.

Source, firmware, and the product-security model live in one worktree. Git `.fs/` YAML is the contract truth (VERSIONED + OVERLAY). Platform holds facts (findings, VEX, SBOM, firmware). Assurance Studio is import/seed only. Human-gated export to AS is not what makes work real, and no skill in this tree tells an agent to perform it.

## Identity first

Reference authored entities by stable slug, never by server UUID, and never reuse a slug.

| Prefix    | Kind                   |
| --------- | ---------------------- |
| `THREAT-` | threat                 |
| `COMP-`   | architecture component |
| `ZONE-`   | zone                   |
| `FLOW-`   | dataflow               |
| `REQ-`    | requirement            |
| `CHK-`    | check                  |
| `MIT-`    | mitigation             |
| `HBOM-`   | hardware part          |

Findings use the stable-key ladder from `fs_findings_query`: purl tier first, then name/group/version. Finding UUIDs change across versions; do not key a decision on them.

## Workflow

1. Read CACHED facts with the registered query tools, or read authored YAML with native file tools.
2. Write intent only to tracked local YAML through the registered write tools, or through native edits of VERSIONED/OVERLAY files. Writes are proposals.
3. Check the proposal with `fs_sync_plan`. If it reports conflicts or orphans, stop and tell the human.
4. Render entities with directives; cite them with mentions. Do not paste payloads the directive already shows.

Four data classes:

- **VERSIONED** — git YAML under `product-security/` (the authored model).
- **OVERLAY** — git YAML under `.fs/` keyed by a stable business key (triage, links, check params).
- **CACHED** — SQLite facts refreshed by pull. Query tools exist because native files are not the answer.
- **ACTION** — invoked, not stored. This tree names exactly three ACTION tools: `fs_verification_run`, `fs_bench_run`, and `fs_firmware_materialize`. They may invoke owner services; they do not mutate the authored model. Each invocation is logged. Host/provider approval UI, if any, is not this plugin's safety boundary.

The agent cannot push, resolve conflicts, accept HBOM cells, or attest manually. Those are human gates. There is no push tool.

## Evidence and review expectations

Claim "verified" only when cached results say so. A queued job is not evidence. If a conclusion is worth keeping, write it into the decision's evidence field — the next session only knows what the files know.

After any write: summarize, point at the paths/diff, run `fs_sync_plan`, emit the relevant directive, and stop for human review.

## Tools and native-file boundaries

Authored YAML needs no read tool. Native `Read` / `Grep` / `Glob` already reach VERSIONED and OVERLAY files. Query tools exist only for CACHED data or YAML⋈cache joins.

Do not duplicate the live `bb finite-state` tree here. The generated `plugin-commands` skill lists the verbs that exist in this checkout. This skill tree does not teach CLI push.

## What to render

Tools return ids. Directives render them. Mentions resolve at send time:

- `@` authored model and documents (`@REQ-104`, `@THREAT-22`, `@datasheet:bcm6755`)
- `#` world identifiers (`#CVE-2023-42364`, `#busybox@1.36.1`)
- `~` runs and verdicts (`~bench-run-88`)

Pairings live in the surface skills. Pair `fs_sync_plan` with `::fs-plan{id}`.

## Never

- Never call `fs_sync_push`. That identifier is not a registered tool. The agent cannot push.
- Never resolve conflicts, accept HBOM cells, overwrite vendor VEX, or write a manual attestation.
- Never invent ids, fabricate `source_ref`s, or call a decision "applied" or "verified" from prose alone.

---
