# Anki compatibility (current evidence)

This is a deliberately evidence-based snapshot of the package interchange and
template behavior exercised by this repository. It describes verified package
fixtures, not a claim of compatibility with every Anki release. The reproducible
official-engine corpus currently covers Anki **26.09.3 only**; that point version
is the only release supported by release-specific package evidence. It does not
establish a wider earliest-to-latest compatibility range.

## Feature matrix

| Construct | Current status | Evidence / boundary |
|---|---|---|
| `.apkg` / `.colpkg` package formats | Partial | Synthetic package round trips plus an on-demand official Anki 26.09.3 collection package; no other release is qualified. |
| Basic fields, tags, decks, templates | Partial | Package import/export preserves tested fields, tags, decks, and templates; broad real-world template corpus is absent. |
| Reversed cards | Verified in 26.09.3 corpus | Two official-engine card templates are imported, rendered in both directions, studied, exported, and re-imported with note/card meaning retained. |
| Multiple templates | Partial | Native IDs and note relationships tested across export (`anki-export.test.ts`); full real-package study journey not established. |
| Cloze | Partial | Rendering and ordinal behavior tested (`template-renderer.test.ts`); export relationships/ordinals tested (`anki-export.test.ts`). |
| Furigana / Japanese reading filters | Partial | Synthetic renderer test covers supported reading filters; this does not establish every Anki filter variant. |
| Typed answers | Partial | Typed-answer metadata is tested; answer-entry grading/input parity is not established. |
| Template CSS | Partial | CSS is included in generated navigation packages, but standalone CSS fidelity coverage is limited. |
| Images and audio | Partial | The 26.09.3 corpus verifies generated WAV bytes, digest, two references to one deduplicated blob, audio rendering and Chromium playback, then export/re-import digest equality. Broader codec and real-world media coverage is unverified. |
| Image occlusion | Partial | Rectangular native subset is covered by a hand-authored fixture and import/export tests. Other shapes are reported unsupported. |
| Filtered decks | Partial, explicit flattening | The 26.09.3 collection package places all four cards in a filtered deck. Import restores them to the original source deck and preserves card/note meaning through study and round trip. The filtered search definition and native filtered-deck scheduling behavior are not retained; this is not filtered-deck parity. |
| Review history / scheduling | Partial | Package tests cover scheduling and review records; scheduler parity tests are synthetic and limited to named behaviors. |
| Unsafe markup, schemes, unsupported template features | Supported rejection behavior | Tests exercise safe rejection and explicit unsupported-feature errors; warning stability across a corpus is not established. |

“Partial” means a named synthetic test exists for some behavior. It does not
mean general compatibility with all upstream variants.

## Fixture provenance

| Fixture | Provenance | License / redistribution |
|---|---|---|
| `tests/fixtures/secure-navigation.ts` | Synthetic package builder and one-pixel image authored for this repository's tests. | Repository-authored; no upstream deck content. |
| `tests/fixtures/image-occlusion-rectangles.json` | Hand-authored minimal example based on the cited upstream Anki TypeScript shape conversion and rectangle definitions. | The JSON example is repository-authored. Upstream source attribution is recorded in the fixture. Do not treat this as an upstream package export. |
| Other `.apkg` test inputs | Generated inline by test helpers using `ankipack`, not checked-in redistributable decks. | No third-party deck corpus is currently included. |
| `.runtime/compatibility/anki-26.09.3.colpkg` and neighboring JSON | Generated on demand by `scripts/generate-anki-compatibility-package.py` with the official Anki 26.09.3 Python distribution at source commit `29bb700`. The collection has two short Japanese note pairs, a reverse template, a filtered deck, and a generated WAV tone. | The notes, templates, and tone are project-authored and marked CC0-1.0 in the generated manifest. The archive is deliberately not committed or redistributed because it serializes stock Anki defaults whose content licensing is not explicitly resolved by the upstream docs. See [fixture provenance research](research/anki-package-fixture-provenance.md). |

## Release-gate gaps

Run `npm run test:anki-compatibility` to regenerate the 26.09.3 collection
package with pinned official Anki code, import it into clean storage, render and
study its forward/reversed cards and audio, export it, and verify a clean
re-import by meaning and media digest. The generated package and its manifest
stay in ignored `.runtime/compatibility/` storage.

Issue #25 remains open. Before claiming a multi-release supported Anki-version
matrix, add on-demand fixtures for additional identified releases, record their
source and content terms, and run the same deterministic import → render/study →
export → clean re-import assertions for each construct. Extend coverage to
real-world card/template variants, filtered-deck policy, scheduling/history,
and media references. Record stable warnings for unsupported constructs and
keep unsupported package behavior isolated from valid notes.

Current automated evidence lives in `src/anki-import.test.ts`,
`src/anki-export.test.ts`, `src/template-renderer.test.ts`,
`src/template-navigation-import.test.ts`, `src/hint-compatibility.test.ts`,
`src/image-occlusion-interchange.test.ts`, and `src/anki-parity.test.ts`.
