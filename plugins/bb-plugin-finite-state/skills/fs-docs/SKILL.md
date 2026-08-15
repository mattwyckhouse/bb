---
name: fs-docs
description: Document search, datasheet pages, sheet cells, and region-level citations in a Finite State workspace. Use to ground a source_ref, find a spec clause on a page, or stop on image-only PDFs that need OCR — not to accept HBOM cells or author threat YAML.
---

# Purpose and when to use

Documents are evidence. `fs_doc_search` finds page/region hits in the document ledger. Extractions that land in HBOM cells go through `fs_hbom_extract` (see `fs-bom`); extractions that ground a requirement stay in `source_description` / rationale via `fs_requirement_write` (see `fs-product-security`). This skill is the citation craft those writes depend on.

## Identity first

Every citable span has:

- `documentSha256` — the registered document, not its display name
- a `locator`:
  - `kind: "pdf"` with `page` (and optional bbox `[x0,y0,x1,y1]` in 0–1)
  - `kind: "sheet"` with `sheet` and `cell` (`A1`, `B4`, …)
  - `kind: "text"` with `lineStart` / `lineEnd`

Render the document with `::fs-doc{id}` where `id` is the tool's document id. Mention it as `@datasheet:bcm6755` when talking to the user.

## Workflow

1. Search with `fs_doc_search` `{ project_id, query, doc_type?, project_version_id?, cursor, limit }`. Hits include page/region `source_ref`s. Totals tell you scale; filter tighter rather than paging for a dump.
2. Open cited bytes with native file tools only after you have a `documentSha256`. Prefer the region the search returned.
3. Extract only fields you can point at. For HBOM, submit cells through `fs_hbom_extract` with that `source_ref` and numeric `confidence` 0–1. For requirements, quote the page in rationale and keep `source_description` verbatim.
4. Image-only or scanned PDFs: stop and tell the human OCR is needed. Do not fabricate a locator.
5. Never overwrite a human-reviewed HBOM cell "from the doc."

## Evidence and review expectations

A citation without page, cell, or line range is not a citation. Low confidence is honest. If two pages disagree, record both spans.

After an extraction that wrote YAML: summarize cited pages/cells and confidence; point at the paths/diff; call `fs_sync_plan`; emit `::fs-doc{id}` (and `::fs-hbom-summary` if HBOM changed); stop for human review. Search-only answers still emit `::fs-doc{id}` rather than pasting document bodies — the tool never returns bodies.

## Tools and native-file boundaries

- `fs_doc_search` — ranked retrieval; `::fs-doc{id}`.
- `fs_hbom_extract` / `fs_hbom_review` — when the destination is HBOM; acceptance stays human-only.
- `fs_requirement_write` — when the destination is a requirement rationale.
- Native `Read` of already-registered document bytes. Do not duplicate a documents CLI tree; WP-64 verbs are out of scope.

## What to render

- Document card → `::fs-doc{id="<docId>"}`
- Component/part tied to a citation → `::fs-component{purl|part}` (see `fs-bom`)
- Mentions → `@datasheet:bcm6755`

## Never

- Never call `fs_sync_push`.
- Never fabricate a `source_ref`, page, bbox, or cell, and never paste a document body as if it were a citation.
- Never continue through an image-only PDF, accept an HBOM cell, or upgrade confidence to hide an unreadable scan.

---
