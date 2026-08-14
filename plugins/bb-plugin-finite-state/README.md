# bb-plugin-finite-state

One integrated bb plugin for findings, Product Security, BOMs, firmware, documents, bench evidence, sync review, and thread-native agent workflows.

## Findings drift commands

The plugin's single agent-discoverable command tree includes local findings drift operations:

```text
bb finite-state triage drift report  --project <platform-id> --version <pv-id> [--cursor <key>] [--limit 100] [--json]
bb finite-state triage drift refresh --project <platform-id> --version <pv-id> [--limit 100] [--json]
bb finite-state triage import-vex <worktree-relative.json> --vendor <name> --project <platform-id> --version <pv-id> [--dry-run] [--overwrite] [--json]
bb finite-state triage orphans --project <platform-id> --version <pv-id> [--json]
bb finite-state triage orphans --prune --stable-key <key> --expected-base <sha256> --confirm --project <platform-id> --version <pv-id> [--dry-run] [--json]
```

`drift report` is a zero-write persisted-index read. Refresh and import update local projections or local proposal YAML only. `--overwrite` is a human CLI/panel affordance and is absent from agent tools. Orphan deletion additionally requires an explicit selection, the digest from a fresh `orphans` read, and `--confirm`; preview it with `--dry-run` first.

Implementation is governed by the approved corpus in `docs/`. Start with `docs/Implementation/HANDOFF — Product & Architecture.md`, then the Master Plan, this directory's `AGENTS.md`, RECON, the work-package index, and Product Specs 00–06.

The Tasks project is `FS`; immutable WP titles map WP-01…WP-70 to FS-15…FS-84. Each WP runs in an isolated bb worktree from `finite-state/integration`, creates a PR, and requires independent review before merge.
