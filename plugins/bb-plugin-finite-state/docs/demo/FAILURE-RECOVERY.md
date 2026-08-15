# Golden Loop failure recovery

Preserve the run directory and captured DOM/report artifacts before recovery.
Never delete evidence to obtain a clean screen. For a non-idempotent push or
bench dispatch, **query status first**.

```console
bb finite-state status all --project project-ax3000-demo --version pv-ax3000-2.4 --json
bb finite-state plan all --project project-ax3000-demo --version pv-ax3000-2.4 --json
bb finite-state bench list --pv pv-ax3000-2.4 --json
bb finite-state firmware status pv-ax3000-2.4 --json
```

| Symptom / code                                                                                        | Honest state and artifacts                                                                                  | Safe recovery                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-field plan conflict / `SYNC_CONFLICT`                                                            | Sync status and plan name the stale tuple; preserve `artifacts/sync/{plan,base}.json`.                      | Pull status, review the conflict, re-plan, then obtain a new human approval. Never reuse the stale plan hash.                                                    |
| Partial VEX push / `VEX_PARTIAL_FAILURE` or `AMBIGUOUS_WRITE`                                         | The run report distinguishes applied and pending rows; successful base rows advance and failed rows do not. | **Query status first.** Resume the existing run. Confirm the retry contains only failed/pending rows and no successful noop.                                     |
| Interrupted writer / `OVERLAY_CAS_CONFLICT`                                                           | Authored YAML stays parseable and `triage-run.incomplete.json` records partial counts.                      | Inspect the YAML and marker, refresh the CAS hash, and rerun. Convergence means already-written decisions are skipped, not rewritten.                            |
| Firmware gap / `MOUNT_INCOMPLETE`, `FIRMWARE_ADMIN_BYTES_REQUIRED`, or `UNPACK_INPUT_DIGEST_MISMATCH` | Metadata and unpack errors remain visible; safe-to-OTA and Verified remain blocked.                         | Use local standalone unpack with the reviewed image, then verify full materialization and digest before dispatch. API whole-image hydration is not the fallback. |
| Bench unavailable, timeout, or `FORGE_DISPATCH_AMBIGUOUS`                                             | The durable run remains running/failed/timeout with dispatch intent and any known job ids.                  | **Query status first.** Reconcile by run/job id. Retry only after proving no job exists; otherwise resume observation of the existing job.                       |
| Signature/digest binding invalid / `ATTESTATION_BINDING_INVALID`                                      | Preserve the invalid attestation and verdict input; verdict is NOT_SAFE or INCONCLUSIVE, never green.       | Verify current mounted digest, rerun the required check if bytes changed, then sign a new attestation bound to that digest. Do not replace the invalid evidence. |

If recovery cannot prove coherent state, label it `HONESTLY BLOCKED`, retain the
artifacts, and end the pass. Offline, connected, canned, and public-log evidence
must retain their original provenance through every retry.
