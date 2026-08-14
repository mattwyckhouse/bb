# Assurance Studio HTTP-200 error envelopes (FS-211)

Verbatim application-error bodies from the supervisor's FS-207 read-only
capture at `~/bb-demo/captures/fs207/` (approximately 20:30Z on 2026-08-14).
Live AS returned HTTP 200 with these bodies instead of the expected
`data.<collection>` / `data[]` list envelopes. Kept outside
`test/mock-remote/fixtures/` so `generate-seed.ts` does not overwrite them.

| Fixture                            | Capture citation                                                                                                                                                                                                 | Shape                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `threats-failed.json`              | `a97db111-98ae-46c0-a1f2-9868c93ae51b--threats.json` (SHA-256 `a7b6f7726da2cccb653abe12d5b0594555b0462751896a244241c9338ead3c37`); identical twin `c7e5307b-34b6-4979-b3a1-eb2274890781--threats.json`           | `{"error":"Failed to fetch threats"}`                                        |
| `requirements-bad-request.json`    | `54a35838-465a-4d22-8f8b-36a1e25237c5--requirements.json` (SHA-256 `d509b4db7afde4f08c07fdd7961b1368f0ddce5777f447ebe8afdd5b9c7f1ba3`); identical twin `146ea51d-cd75-4dbb-a05e-105edfbf9be5--requirements.json` | `{"error":"Failed to fetch requirements","details":"Bad Request"}`           |
| `requirements-414-cloudflare.json` | `c7e5307b-34b6-4979-b3a1-eb2274890781--requirements.json` (SHA-256 `f5aa2d62d5c3e9ff5e086e2bd7f2b95f82147949d6d1e3686c4ec5aa11b27f0f`)                                                                           | same error key plus Cloudflare `414 Request-URI Too Large` HTML in `details` |

These exercise the Assurance Studio client's refusal to coerce error envelopes
into empty collections or cache them as valid snapshots, while the FS-207
generated corpus continues to preserve per-kind success envelopes.
