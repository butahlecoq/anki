# Anki compatibility (current evidence)

This is a deliberately evidence-based snapshot of the package interchange and
template behavior exercised by this repository. It describes the checked-in
tests, not a claim of compatibility with every Anki release. Package-level
coverage is currently built from generated in-test packages and small synthetic
fixtures; a licensed corpus of packages exported by real Anki versions is still
needed before publishing a version support range.

## Feature matrix

| Construct | Current status | Evidence / boundary |
|---|---|---|
| `.apkg` package format | Partial | Import/export journeys use `ankipack`-generated packages (`anki-import.test.ts`, `anki-export.test.ts`). No compatibility range by Anki release is established. |
| Basic fields, tags, decks, templates | Partial | Package import/export preserves tested fields, tags, decks, and templates; broad real-world template corpus is absent. |
| Reversed cards | Unverified | No dedicated end-to-end fixture or round-trip proof identified. |
| Multiple templates | Partial | Native IDs and note relationships tested across export (`anki-export.test.ts`); full real-package study journey not established. |
| Cloze | Partial | Rendering and ordinal behavior tested (`template-renderer.test.ts`); export relationships/ordinals tested (`anki-export.test.ts`). |
| Furigana / Japanese reading filters | Partial | Synthetic renderer test covers supported reading filters; this does not establish every Anki filter variant. |
| Typed answers | Partial | Typed-answer metadata is tested; answer-entry grading/input parity is not established. |
| Template CSS | Partial | CSS is included in generated navigation packages, but standalone CSS fidelity coverage is limited. |
| Images and audio | Partial | Image bytes/hashes and missing-media export blocking are tested. Audio-specific playback and real package round trips are unverified. |
| Image occlusion | Partial | Rectangular native subset is covered by a hand-authored fixture and import/export tests. Other shapes are reported unsupported. |
| Filtered decks | Partial | Import restores tested card origin deck and due day; filtered-deck study parity is not established. |
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

## Release-gate gaps

Issue #25 is not complete. Before claiming a supported Anki-version matrix, add
minimal packages exported by identified Anki releases, record their source and
license/redistribution terms, and run deterministic import → render/study →
export → clean re-import assertions for each supported construct. Include
audio bytes/playback, reversed cards, real filtered decks, and media-reference
hash accounting. Record stable warnings for unsupported constructs and keep
unsupported package behavior isolated from valid notes.

Current automated evidence lives in `src/anki-import.test.ts`,
`src/anki-export.test.ts`, `src/template-renderer.test.ts`,
`src/template-navigation-import.test.ts`, `src/hint-compatibility.test.ts`,
`src/image-occlusion-interchange.test.ts`, and `src/anki-parity.test.ts`.
