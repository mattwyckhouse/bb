# Golden Loop stage runbook

This runbook presents the shipped 16-beat Golden Loop. The unattended gate is
**OFFLINE FIXTURE — warm cache, deterministic local transports, no external
network**. It is not a connected tenant result, a canned recording, or public
evidence.

Reference gate machine: MacBook Pro Mac16,5, Apple M4 Max (14 cores), 36 GB,
macOS arm64, Node 22.19.0. Each independently copied warm-seed run must finish
in less than 15:00. Shared CI is diagnostic unless it matches this profile;
never loosen the reference assertion to accommodate a contended worker.

## Cache materialization and verification

For each offline automation pass, the Golden Loop harness creates a fresh
disposable Git worktree, copies `test/e2e/golden-loop/seed/worktree`, and
materializes `test/e2e/golden-loop/seed/warm-cache/data.db` into the plugin
store before networking is disabled. Run 2 repeats that materialization from
the committed seed; it never reuses Run 1 state. This is the existing test
harness materializer, not a hidden production fallback.

For a connected rehearsal, warm the cache before disconnecting with
`bb finite-state pull triage --project project-ax3000-demo --version pv-ax3000-2.4 --json`,
then run the shipped status/firmware/bench checks below. This command is
**CONNECTED-ONLY**; it is not part of the offline proof. The remaining seeded
surfaces are materialized by the reviewed Golden Loop harness because there is
no shipped production verb that imports test fixtures.

## Operator preflight (T-05:00)

Use the harness-created disposable demo worktree. Complete
[PREFLIGHT-CHECKLIST.md](./PREFLIGHT-CHECKLIST.md), then record configuration
and cached state. Every fenced command below is expected to exit zero:

```console
bb finite-state connect status --json
bb finite-state firmware status pv-ax3000-2.4 --json
bb finite-state bench list --pv pv-ax3000-2.4 --json
```

Expected seed facts: 16 registered beats; v2.3 and v2.4 each contain four
fully materialized firmware files; 412 new untriaged findings; 306 policy
matches; 305 policy writes; one KEV holdback; 14 carry-forward recoveries;
nine stale decisions; two orphans. The pre-policy beat writes 304, skips one
existing human decision, and holds one KEV.

## Stage pass (T+00:00 to T+15:00)

Start the timer when beat 1 begins. The operator says the prompt in the
Operator column, then waits for the named screen state. Capture each timing in
`run-N/golden-loop-rehearsal.md`; the machine report is
`run-N/golden-loop-report.json`. Beat evidence is under `run-N/beat-NN/`.

| Mark  | Beats | Operator / action                                                               | Screen transition                                                                          |
| ----- | ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 00:00 | 1–4   | “Show fresh sync, review triage, dispatch, then recover the SBOM pull.”         | Sync review → Findings → Bench run → BOM, all showing `OFFLINE FIXTURE` provenance.        |
| 03:00 | 5     | “Keep the quarantined row visible and recover the valid rows.”                  | **Oh moment 1:** partial data remains visible; recovery transcript is captured.            |
| 05:00 | 6–7   | “Write and undo one decision, then trace the requirement into its bench check.” | Reviewable YAML diff → verification evidence. **Oh moment 2:** requirement-to-proof trace. |
| 07:00 | 8–10  | “Read inventory, author the canvas model, and show isolated pull outcomes.”     | BOM → Canvas → Sync; failed kinds are named and successful kinds stay published.           |
| 09:00 | 11    | “Show the failed dispatch evidence and the honest verdict.”                     | **Oh moment 3:** durable failed run; no green verdict.                                     |
| 10:30 | 12    | “Bind the signed evidence to these firmware bytes.”                             | **Oh moment 4:** digest-bound attestation and verdict card.                                |
| 12:00 | 13–16 | “Finish selection, carry-forward, human rejection, and policy application.”     | Explicit AS selection → drift → durable review → 304/1/1 policy summary.                   |

At the end, require 16 passed, zero failed/skipped, zero offline violations,
and duration below 900,000 ms. Report the slowest beat. Dispose the run, copy
the warm seed independently, and repeat; semantic report, final git tree, plan
results, verdict, and attestation hash must match.

## Provenance rules

- `OFFLINE FIXTURE`: acceptable for the unattended gate; no external claims.
- `CONNECTED DEV TENANT`: only during the separately labeled connected rehearsal.
- `CANNED RUN`: fallback presentation only; it cannot satisfy the gate.
- `PUBLIC LOG UNAVAILABLE`: show this label and retain local evidence; never imply
  public verification.

On any gap, stop the beat timer, preserve the run directory, and follow
[FAILURE-RECOVERY.md](./FAILURE-RECOVERY.md). A failure is part of the demo only
when its status and evidence remain visible.
