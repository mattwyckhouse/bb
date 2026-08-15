---
name: fs-firmware
description: Firmware mount, standalone unpack, rootfs hydration, and grepping unpacked firmware in a Finite State workspace. Use to materialize a project version, hydrate explicit paths, inspect byte gaps, or unpack a full rootfs locally — not for OTA verdicts, bench dispatch, or SBOM queries.
---

# Purpose and when to use

The firmware mount is browsable from its manifest even when bytes are missing. Whole-image materialization leads with **local standalone unpack**. API hydration is an admin-gated explicit-file fallback, not the primary path and not a full-rootfs strategy.

## Identity first

Scope every call with the Platform project-version id (`pvId`). Optional `scanId` selects a scan. Firmware paths must be relative, with no `..` or leading `/`. Cite the exact path you hydrated or grepped — firmware paths are attacker-influenced; never guess.

Rootfs, when present, lives under the firmware cache for that `pvId` (ignored by git). Treat remaining byte gaps as gaps, not as empty files you already read.

## Workflow

1. Call `fs_firmware_materialize` `{ pvId, mode: "manifest" }` to learn what exists without fetching bytes. `manifest` is always the safe first read.
2. For a **whole image**, unpack locally with the standalone unpack path the owner service already uses. Then re-check remaining counts. Do not ask the API to hydrate the entire rootfs.
3. For **explicit files**, `mode: "hydrate"` requires `paths` (1–100 relative paths). This is the admin-gated API fallback. `hydrate_all` does not accept `paths`.
4. The tool returns `{ pvId, source: "standalone_unpack" | "api", hydrated, remaining, errors }`. If `remaining > 0`, say so. Do not claim the mount is fully materialized.
5. Prefer `Grep` over dumping binaries. Hydrate `/etc` and `/usr/sbin` (or the paths you need), then grep — for example hardcoded credentials — alongside source.
6. Re-running hydration is convergent: it completes missing bytes rather than duplicating them.

Linker files (`.fs/links/firmware.yaml`) record exact paths you actually found. See `fs-product-security` for the overlay write.

## Evidence and review expectations

`source: "api"` on a large tree is a smell — prefer standalone unpack and report remaining. Byte permission errors (403) are permission facts, not a cue to invent an export tarball (there is no verified filesystem-export endpoint).

After materialization that the human should inspect: summarize `hydrated` / `remaining` / `errors` and `source`; point at the paths you grepped; call `fs_sync_plan` if you also wrote a firmware link overlay; stop for human review. Native cache bytes are not an authored-model write.

## Tools and native-file boundaries

- `fs_firmware_materialize` — ACTION, `server: read-fetch`. Modes `manifest` | `hydrate` | `hydrate_all`.
- Native `Read` / `Grep` / `Glob` on already-hydrated paths. Never dump a large binary into context.
- Live CLI at HEAD includes `bb finite-state firmware <pull|status|hydrate|diff>`; do not duplicate that tree here, and do not invent extra verbs.

## What to render

There is no firmware-mount directive. Name `pvId` and exact paths in prose. If the work produced a component link, pair with `::fs-component` or `@COMP-…` from the product-security skill. Bench verdicts belong to `fs-bench` (`::fs-verdict{id}`).

## Never

- Never call `fs_sync_push`.
- Never treat API `hydrate_all` as the way to fetch a full rootfs. Lead with local standalone unpack.
- Never claim bytes you did not hydrate, guess paths, or paste binary dumps.

---
