---
name: fs-bom
description: SBOM components, licenses, HBOM parts, MPNs, datasheets, source_ref citations, and country-of-origin proposals in a Finite State workspace. Use to query the SBOM, propose HBOM cells with numeric confidence, or inspect the review queue — never to accept or reject HBOM cells.
---

# Purpose and when to use

Two postures. SBOM is a read-only CACHED fact plane (`fs_sbom_query`). HBOM is authored YAML under `product-security/hbom/hbom.yaml`; the agent proposes cells through `fs_hbom_extract` and a human accepts them. Git is the contract truth for HBOM; Platform holds SBOM facts.

## Identity first

- SBOM components: prefer the row's component key / purl from `fs_sbom_query`. Render with `::fs-component{purl="…"}`.
- HBOM parts: `HBOM-*` slugs. Match incoming BOM rows by MPN, then reference designator, before creating parts. Render with `::fs-component{part="HBOM-0001"}`.
- Documents used as evidence: `documentSha256` plus a locator (page, sheet/cell, or text lines). Never a filename-only citation.

## Workflow

**SBOM (read).** Call `fs_sbom_query` with `projectId`, `version`, and optional `name`, `purl`, `license`, `license_group`, `min_severity`, `kev`, `reachability`, `linked`, paging. Cite licenses and vuln rollups; do not invent an SBOM write tool.

**HBOM (propose).**

1. Register/read the document (native file tools + `fs_doc_search` for page/region hits).
2. Extract only fields you can cite. Submit through `fs_hbom_extract`:
   - `projectVersionId`, `documentSha256`, `expectedHbomSha256` (CAS against current `hbom.yaml`)
   - `createMissingParts` default false
   - `cells` 1–500, each `{ part, field, value, source_ref, confidence }`
   - `part` is `{ id }` or `{ mpn and/or referenceDesignator }`
   - `field` is a closed HBOM part field (`mpn`, `manufacturer`, `countryOfOrigin`, …)
   - `confidence` is numeric 0–1, honest, not optimistic
   - `source_ref` is `{ documentSha256, locator }` where `locator.kind` is `pdf` (page, optional bbox), `sheet` (sheet + cell like `B4`), or `text` (lineStart/lineEnd)
3. On disagreement between two documents, submit both candidates. Do not pick a winner.
4. Inspect the queue with `fs_hbom_review` `{ projectId, state: review|conflict|all }`. Read-only. Acceptance is human-only.
5. Image-only / scanned PDFs: stop and say OCR is needed. Do not guess an MPN from a bitmap.

## Evidence and review expectations

Agent claims remain proposals. Conflicts become candidate records. No input may set `accepted`, `provenance: human`, or review status. Prefer tables over running text; a part number in prose is a candidate.

After extraction: summarize merged / queued / conflicts / rejected; point at `product-security/hbom/hbom.yaml` and the diff; call `fs_sync_plan`; emit `::fs-hbom-summary`; stop for human review. Never describe an unaccepted cell as confirmed.

## Tools and native-file boundaries

- `fs_sbom_query` — CACHED components for `::fs-component{purl}`.
- `fs_hbom_extract` — merge engine write into `hbom.yaml`.
- `fs_hbom_review` — review queue; cannot accept or reject.
- `fs_doc_search` — page/region hits to ground `source_ref`.
- Do not edit `hbom.yaml` around the merge engine. Do not duplicate the CLI tree. HBOM accept/reject CLI, if present later, would still be a panel handoff — not an agent resolution path. This tree does not teach it.

## What to render

- Component → `::fs-component{purl="pkg:generic/busybox@1.36.1"}`
- Part → `::fs-component{part="HBOM-0001"}`
- After extraction → `::fs-hbom-summary`
- Mentions → `#busybox@1.36.1`, `#BCM6755`

## Never

- Never call `fs_sync_push`. Never accept, reject, or human-stamp an HBOM cell.
- Never invent a `source_ref`, upgrade confidence to hide doubt, or overwrite a human-reviewed cell.
- Never continue extraction on an image-only PDF as if OCR had run.

---
