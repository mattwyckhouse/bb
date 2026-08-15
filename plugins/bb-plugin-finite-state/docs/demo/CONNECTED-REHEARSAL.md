# Connected rehearsal (connected-only)

Every screen in this procedure must display `CONNECTED DEV TENANT`. It is a
human rehearsal and does not satisfy the unattended offline gate.

```console
bb finite-state connect status --json
bb finite-state pull all --project project-ax3000-demo --version pv-ax3000-2.4 --json
bb finite-state status all --project project-ax3000-demo --version pv-ax3000-2.4 --json
bb finite-state bench list --pv pv-ax3000-2.4 --json
```

1. Operator A confirms the approved tenant, host, daemon, cache hashes, evidence
   fixture, and reset authorization. Without an approved reset command, record
   `CONNECTED_RESET_UNAVAILABLE` and rehearse read-only; never invent a reset.
2. Operator B runs all 16 prompts in the stage runbook and records timing,
   screen transitions, deviations, and provenance under `connected/pass-1/`.
3. Before push or bench dispatch, Operator B reads back the target. These are
   non-idempotent: **query status first** after any timeout or disconnect.
4. Repeat as `pass-2` without builder intervention. Do not weaken counts,
   assertions, or evidence binding to fit staging.
5. Record public evidence separately. A valid local DSSE signature with an
   unavailable public log is labeled `PUBLIC LOG UNAVAILABLE`, not published.

Required rehearsal evidence is two consecutive offline machine passes and two
connected human passes by the second operator. Each pass records start/end,
total duration, slowest beat, deviations, operator identity, provenance, and
the report/artifact paths. A canned run may be shown only with the persistent
label `CANNED RUN`; it is never substituted into those four pass records.
