# Owner live fs-cli evidence capture (WP-101 ratification condition)

This is the **one remaining owner-only acceptance step**. CI stays fully offline;
the stage0-binding harness is the in-repo stand-in. Declaring stage 0 proven
still requires attaching one live `fs-cli` invocation against this fixture.

## Fixture location

Committed checkout corpus (canonical requirements root):

- `product-security/requirements/REQ-FW-SIG.yaml`
- `product-security/requirements/REQ-ADMIN-AUTH.yaml`
- `product-security/requirements/REQ-UPDATE-FAILCLOSED.yaml`
- `product-security/requirements/REQ-COMPLEX-AUDIT.yaml`

Expected binding rows (stable key + EARS text + status + source path):

- `expected-bindings.json`

## 10-minute confirmation

1. Copy this `fixture-repo/` directory to a disposable working tree (or point
   `fs-cli` at it in place).
2. Ensure Assurance Studio / Graph publish are **not** configured for the run.
3. Invoke the live `fs-cli` Code Assurance path that binds requirements from
   the local YAML corpus (the same stable-key + EARS-text inputs exercised by
   `stage0-binding.test.ts`).
4. Capture stdout/stderr plus the command line into a file such as
   `fs217-live-fs-cli.txt`.
5. Attach that file to task FS-217 and note that every `expected-bindings.json`
   stable key bound with matching EARS text.

No network publish step is required. No AS round-trip is required.
