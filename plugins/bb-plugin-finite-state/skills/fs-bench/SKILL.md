---
name: fs-bench
description: Verification bench runs, tier0/tier1 dispatch, run status, artifacts, and safe-to-OTA verdicts in a Finite State workspace. Use for bench run, verdict cards, and whether a mount is ready to test — not to assert safe-to-OTA in prose, unpack firmware, or author requirements.
---

# Purpose and when to use

A bench run is an ACTION invocation, not a YAML edit. `fs_bench_run` dispatches after owner-side firmware-digest and full-materialization preflight. Results land as cached evidence. The signed verdict card is the safe-to-OTA artifact — prose is not.

## Identity first

- Dispatch with `pvId` (project version). Optional `requirement` and `target` pin coverage.
- Follow-up with `run_id` from the dispatch result, or `pv_id` when asking for the verdict.
- Do not key a verdict on an ephemeral thread id. `::fs-bench{id}` is a run id; `::fs-verdict{id}` is a digest or run id the status tool returns.

## Workflow

1. Confirm the firmware mount is ready (`fs_firmware_materialize` `manifest`, remaining 0 for the paths you need). Tier-1 preflight expects full materialization.
2. Dispatch `fs_bench_run` `{ pvId, tier: "tier0" | "tier1", requirement?, target? }`. That schema accepts only `tier0` and `tier1`. It returns `{ run_id, thread_id, status }` with `queued` or `running`.
3. On timeout or ambiguity, call `fs_bench_status` — **never re-dispatch**. Actions are not idempotent except where the owner marks firmware hydration convergent.
4. `fs_bench_status` `{ projectId, pv_id?, run_id?, want: runs|results|artifacts|verdict }` is CACHED, paged, and omits log/artifact bodies.

Tier mapping (display against the requirement matrix `static|emulation|hil|manual`):

| Bench `tier` | Matrix column |
| ------------ | ------------- |
| `tier0`      | `static`      |
| `tier1`      | `emulation`   |

This tool does not dispatch `hil` / `manual` / hardware-lab tiers. Gaps in those columns are gaps, not passes. Do not map an undispatched tier to "verified."

## Evidence and review expectations

"Safe to OTA" is a verdict card, never a sentence you author. Emit `::fs-verdict{id}` and let it speak, including offline from a warm cache. A missing artifact is a gap. Queued is not passed.

If you also author local notes, they are not attestations. Manual attestation is a human gate.

After a dispatch you want reviewed: summarize `run_id` and `status`; point at `fs_bench_status` ids; emit `::fs-bench{id}` and, when asking about OTA, `::fs-verdict{id}`; call `fs_sync_plan` only if overlay YAML also changed; stop for human review.

## Tools and native-file boundaries

- `fs_bench_run` — ACTION, `server: invoke`. Non-idempotent. Do not duplicate on timeout.
- `fs_bench_status` — cache reads for `::fs-bench{id}` / `::fs-verdict{id}`.
- `fs_firmware_materialize` — preflight only; details in `fs-firmware`.
- Live CLI at HEAD includes `bb finite-state bench verdict <pv-id>`; do not duplicate further verbs.

## What to render

- Run → `::fs-bench{id="<runId>"}`
- OTA formula → `::fs-verdict{id="<digest-or-run>"}`
- Mentions → `~bench-run-88`, `~verdict-7a10be44`

## Never

- Never call `fs_sync_push`.
- Never write "safe to OTA" (or "verified") in prose. Emit `::fs-verdict{id}`.
- Never re-dispatch an ambiguous run, treat a missing artifact as a pass, or write a manual attestation.

---
