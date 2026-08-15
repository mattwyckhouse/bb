# Golden Loop preflight checklist

Run this only in a disposable demo worktree. It is a checker, not an automated
tenant reset. The destructive dev-tenant reset command is intentionally omitted
until an owner approves one.

## Offline gate

- [ ] Node is 22.19.0 and the plugin four-command gate is green.
- [ ] Plugin settings report their actual state; remote credentials are not
      required for `OFFLINE FIXTURE` mode.
- [ ] `seed/manifest.json`, warm-cache `data.db`, run events, firmware manifests,
      source files, and attestation hashes match the committed manifest.
- [ ] The disposable worktree is clean before the run; the developer checkout
      is never reset or cleaned by this procedure.
- [ ] v2.3 digest is `44a82b…ce9`; v2.4 digest is `148b4a…af6d`; each manifest
      reports four of four files materialized and no unpack gap.
- [ ] Expected counts are 412 / 306 / 305 / 1 / 14 / 9 / 2 as described in the
      stage runbook; the pre-policy counts are 304 writes, one skip, one holdback.
- [ ] DSSE fixture and public-key hashes match. Public-log availability is
      shown independently and may not be inferred from a valid local signature.

```console
bb finite-state connect status --json
bb finite-state status all --project project-ax3000-demo --version pv-ax3000-2.4 --json
bb finite-state firmware status pv-ax3000-2.3 --json
bb finite-state firmware status pv-ax3000-2.4 --json
bb finite-state bench verdict pv-ax3000-2.4 --digest 148b4a814b5b2057d855afa7ebdae4d6698e8632e2b1a2ed4a169a0514a1af6d --json
```

Hash and git-cleanliness checks are performed by the committed seed verifier
and Golden Loop harness, which use shipped plugin/host paths; do not substitute
an unreviewed reset or mutation command.

## Connected-only additions

- [ ] Label the screen `CONNECTED DEV TENANT`; never call it the offline gate.
- [ ] Confirm the intended dev tenant and bench host aloud with the second operator.
- [ ] Verify host enrollment and daemon health with the shipped core `bb machine`
      status command before entering the plugin flow.
- [ ] Obtain explicit approval and the approved reset command. If absent, skip
      reset and record `CONNECTED_RESET_UNAVAILABLE`; do not infer authority.
- [ ] Verify external evidence publication separately. If unavailable, show
      `PUBLIC LOG UNAVAILABLE` and preserve local evidence.
