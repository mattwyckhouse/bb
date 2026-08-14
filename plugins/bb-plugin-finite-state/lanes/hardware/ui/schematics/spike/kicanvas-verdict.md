# KiCanvas spike verdict: NO-GO

Tested 2026-08-14 against KiCanvas commit
`b031159eb74aaa7eef2b026fd85d35bc05ff2095` in desktop Chromium. The spike used
KiCanvas's own production build and embedding elements; it did not add KiCanvas
or change the plugin lockfile.

## Decision

**NO-GO.** Keep `kicad-cli` SVG as the plan of record for schematic and board
rendering. KiCanvas displayed the basic vector geometry, but it did not render
the fixture corpus without parser compatibility warnings, and its ordinary
single-source embed skipped referenced child sheets unless every sheet was
preloaded manually. A viewer that silently ignores current-format fields is not
a safe fallback for a hardware design plane.

This verdict does not change the parser, cache, linking, or HBOM paths. It does
not remove or weaken the `kicad-cli` SVG path. A future KiCanvas experiment must
be a separate gated work package after a dependency amendment and should vendor
a maintained fork before production use.

## Fixture evidence

| Fixture                                                        | Authored format                                                       | Result                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom-fields/custom_fields.kicad_sch` and `sensor.kicad_sch` | KiCad 9.0.7; schematic format `20250114`, generator `9.0`             | Root and child render when both files are explicitly supplied. KiCanvas warns that KiCad 9 sheet fields `exclude_from_sim`, `in_bom`, `on_board`, and `dnp` have no definitions. With the ordinary single-file embed, the child is skipped as nonexistent. |
| `custom-fields/custom_fields.kicad_pcb`                        | KiCad 9.0.7; board format `20241229`, generator `9.0`                 | Board geometry renders. KiCanvas warns that mask `tenting` syntax and the footprint `dnp` element are undefined, so current-format board semantics are not lossless.                                                                                       |
| `semantic/semantic.kicad_sch` and `sensor.kicad_sch`           | KiCad 8 generation; schematic format `20231120`                       | Root and child render when both are explicitly supplied. KiCanvas warns that the sheet `in_bom` and `on_board` fields are undefined.                                                                                                                       |
| `rotated-symbols/rotated_symbols.kicad_sch`                    | KiCad 8 generation; schematic format `20231120`                       | Loads and paints the authored rotated/mirrored symbols without a fatal parser error. This positive result does not offset the KiCad 8/9 hierarchy and field gaps above.                                                                                    |
| `cycle/`                                                       | Original KiCad 8-format negative fixture, format `20231120`           | Not treated as a rendering success candidate: the project intentionally contains a hierarchy cycle and must be rejected by the semantic parser.                                                                                                            |
| `corrupt/`                                                     | Original truncated KiCad 8-format negative fixture, format `20231120` | Not treated as a rendering success candidate: the schematic is intentionally malformed and must fail parsing.                                                                                                                                              |
| `legacy/`                                                      | Original KiCad 5 legacy-header negative fixture                       | Not treated as a rendering success candidate: KiCad 5 is explicitly unsupported by both the lane and KiCanvas.                                                                                                                                             |

Captured task evidence:

- `kicanvas-custom-fields-embed.png`: KiCad 9 root-sheet render after explicitly
  preloading both hierarchy files.
- `kicanvas-custom-fields-board.png`: KiCad 9 board render associated with the
  `tenting` and `dnp` compatibility warnings.
- `kicanvas-semantic.png`: KiCad 8 hierarchical fixture render.
- `kicanvas-rotated-symbols.png`: KiCad 8 transform fixture render.
- Browser console captures: KiCanvas parser warnings and hierarchy-loading
  messages quoted in the table above.

The largest schematic fixture in this corpus is the 15,648-byte KiCad 9 root
sheet. It reached a painted, fit-to-view canvas during the browser smoke without
an observable interaction stall; precise SVG load and zoom timing belongs to
the production `kicad-cli`/React Flow journey, not this rejected renderer.
