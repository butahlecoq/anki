# Anki compatibility (current evidence)

This is an evidence-based snapshot of package interchange and template behavior
exercised by this repository. “Supported” means the named behavior has an
automated end-to-end check; “partial” means only the evidence/boundary listed is
verified; “unqualified” means no release-specific package has been checked.
There is no claimed compatibility range.

## Anki release matrix

| Official release | Package compatibility status | Evidence |
|---|---|---|
| 26.09.3 | Partially supported | The pinned official Python exporter generates an ephemeral `.colpkg`; `npm run test:anki-compatibility` imports it, renders/studies forward and reversed cards with audio in desktop Chromium, exports it, and semantically re-imports it. Filtered-deck search/scheduling semantics are intentionally flattened. The checked-in synthetic corpus has a complete import/render/study/export/re-import journey for its explicitly authored note, template, image-occlusion, media, and review-history fixtures. |
| 26.09.2, 26.09.1, 26.09, 26.08.1, 26.08, 26.05 | Unqualified | Release tags exist, but this repository has not generated and checked a package from these releases. |
| Other Anki releases, including future releases | Unqualified | No release-specific package evidence. Do not infer support from the 26.09.3 result. |

No release is currently classified as known-incompatible. “Unsupported” below
describes feature boundaries, not release versions; all releases beyond 26.09.3
remain unqualified.

“Unqualified” is an evidence status, not a claim that the release is known to
fail. The current tests do not establish an oldest supported version.

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
| Review history / scheduling | Partial | Package tests cover scheduling and review records; scheduler parity tests are synthetic and limited to named behaviors. Default 20-minute intraday learn-ahead returns Learning/Relearning cards when displayable due work is exhausted; future review and interday cards remain excluded. `scripts/verify-learning-queue-oracle.py` compares queue repetition against official Anki 26.9.3. |
| Unsafe markup, schemes, unsupported template features | Supported rejection behavior | Tests exercise safe rejection and explicit unsupported-feature errors; warning stability across a corpus is not established. |

## Explicit boundaries

| Surface | Supported subset | Unsupported or unqualified behavior |
|---|---|---|
| Package versions | The end-to-end 26.09.3 collection package journey above. | Every other release is unqualified; `.apkg` has synthetic/import-export evidence only, not a release-specific upstream export journey. |
| Note types | Basic-style standard notes; tested two-template notes; cloze ordinals; rectangular native image occlusion. | Other image-occlusion shapes are rejected. Arbitrary custom note-type behavior is not claimed. |
| Template filters | Field interpolation, `text`, `furigana`, `kana`, `kanji`, `cloze`, `hint`, and typed-answer metadata have unit coverage. | Unknown filters (including `reverse` and `type:nc`) and malformed cloze syntax are rejected; no claim of full Anki filter parity. |
| Templates | Tested fields, conditionals, `FrontSide`, CSS preservation, and safe markup handling. | Anki JavaScript, arbitrary executable/resource markup, and untested template features are not supported. |
| Media | PNG and generated WAV examples; content digests are checked; missing media prevents successful export. | Other codecs and broad real-deck media variants are unqualified. |
| Scheduling | Named FSRS/native scheduling fields and review facts have synthetic round-trip checks. | Scheduler parity outside the named tests is unqualified. Filtered-deck search and native rescheduling semantics are not retained. |

Import findings expose stable machine codes and human-readable details. Current
tests assert `unsupported-note-type` plus `note-skipped` for unsupported
templates, `field-html-sanitized` for removed markup, `media-malformed` for
invalid media, and `scheduling-mapped` for scheduling conversion. The mixed
supported/unsupported-note test verifies that a learner can explicitly import
representable notes while recording and retaining the excluded note on refresh.

The checked-in fixtures are source-authored test builders and small JSON examples,
not redistributed upstream decks. The official-engine package is generated on
demand and intentionally remains ephemeral; its authorship and content terms
are recorded in the manifest and provenance note below.

“Partial” means a named synthetic test exists for some behavior. It does not
mean general compatibility with all upstream variants.

## Fixture provenance

| Fixture | Provenance | License / redistribution |
|---|---|---|
| `japanesePackage()` in `src/anki-import.test.ts` | Synthetic `ankipack` package builder: Basic-style/reversed templates, cloze, Japanese furigana, typed-answer metadata, CSS, PNG/WAV, scheduling, and review history. Covered by a complete import/render/study/export/clean-re-import journey. | Original Kiroku test content and generated media; no upstream deck content. Fixture content is CC0-1.0 per [`tests/fixtures/anki-compatibility-content.CC0.md`](../tests/fixtures/anki-compatibility-content.CC0.md). The package is built in memory by the test. |
| `templateMediaPackage()` and `imageOcclusionPackage()` in `src/anki-import.test.ts` | Synthetic package builders for template-level image/audio and rectangular image occlusion. The corpus journey imports, studies, exports, and cleanly re-imports the image-occlusion fixture. | Original Kiroku test content and generated media; no upstream deck content. Fixture content is CC0-1.0; packages are built in memory by tests. |
| Filtered-card variant in `src/anki-import.test.ts` | A source-authored package builder variant puts a scheduled card in a filtered deck with its original deck and due-day metadata. Import restores the original deck and due date; the official 26.09.3 corpus additionally verifies flattening through study/export/re-import. | Original Kiroku fixture content under CC0-1.0; no upstream deck content. |
| `tests/fixtures/secure-navigation.ts` | Synthetic package builder and one-pixel image authored for this repository's tests. | Repository-authored; no upstream deck content. |
| `tests/fixtures/image-occlusion-rectangles.json` | Hand-authored minimal example based on the cited upstream Anki TypeScript shape conversion and rectangle definitions. | The JSON example is repository-authored. Upstream source attribution is recorded in the fixture. Do not treat this as an upstream package export. |
| Other `.apkg` test inputs | Generated inline by test helpers using `ankipack`, not checked-in binary decks. | No third-party deck corpus is included. Original fixture content is CC0-1.0 under the fixture notice; no upstream deck is redistributed. |
| `.runtime/compatibility/anki-26.09.3.colpkg` and neighboring JSON | Generated on demand by `scripts/generate-anki-compatibility-package.py` with the official Anki 26.09.3 Python distribution at source commit `29bb700`. The collection has two short Japanese note pairs, a reverse template, a filtered deck, and a generated WAV tone. | The notes, templates, and tone are project-authored and marked CC0-1.0 in the generated manifest. The archive is deliberately not committed or redistributed because it serializes stock Anki defaults whose content licensing is not explicitly resolved by the upstream docs. See [fixture provenance research](research/anki-package-fixture-provenance.md). |

## Release-gate gaps

Run `npm run test:anki-compatibility` to regenerate the 26.09.3 collection
package with pinned official Anki code, import it into clean storage, render and
study its forward/reversed cards and audio, export it, and verify a clean
re-import by meaning and media digest. The ordinary deterministic test suite
also runs the checked-in synthetic corpus through import, template rendering,
study answers, export, and clean semantic re-import, asserting note/card/review
counts, template shapes, image-occlusion masks, media references, and digests.
The official package and manifest stay in ignored `.runtime/compatibility/`
storage. Assertions are semantic and source/version inputs are pinned; archive
hashes can vary with exporter-generated collection metadata.

The evidence currently qualifies only one Anki release and a deliberately
bounded feature subset. Broader upstream release packages, real-world
card/template variants, and physical installed-iPhone validation remain outside
this evidence and must be completed before making wider compatibility claims.

Current automated evidence lives in `src/anki-import.test.ts`,
`src/anki-export.test.ts`, `src/template-renderer.test.ts`,
`src/template-navigation-import.test.ts`, `src/hint-compatibility.test.ts`,
`src/image-occlusion-interchange.test.ts`, and `src/anki-parity.test.ts`.
