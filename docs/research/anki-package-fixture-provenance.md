# Anki package fixture provenance and redistribution

Research note for [issue #187](https://github.com/butahlecoq/anki/issues/187). Sources checked 2026-10-05. This is a source review, not a legal opinion.

## Findings

### Release identifiers

The official Anki release page identifies **26.09.3** as the latest release, published 2026-09-23, with source commit `29bb700`. Recent stable release identifiers shown there are 26.05, 26.08, 26.08.1, 26.09, 26.09.1, 26.09.2, and 26.09.3. The project's release guide says Anki uses calendar versions (`YY.MM`), optional patch numbers, and prerelease suffixes. These tags establish versions available to reproduce; they do not establish that this repository has generated or tested a package with any one of them.

The current compatibility document identifies its existing generated packages as `ankipack`-generated or synthetic. It names no official Anki release as their producer. The repo's prior engine note mentions `anki==26.9.3`; the official tag spells the release `26.09.3`. That recorded engine version is a known identifier, not evidence of a package-export run.

### What the licenses and docs do establish

Anki's repository license says Anki is under AGPL version 3 or later, with portions contributed under BSD-3; it also lists specific exceptions for vendored code and documentation. The release/repository license is evidence for Anki software source. It does **not** explicitly state a blanket license for arbitrary card content, media, or packages exported by Anki.

The official manual defines `.apkg` and `.colpkg` as packages containing cards, notes, note types, and optionally media. It explains the export options and that packages are used to transfer or back up a collection, but does not specify a content license or grant redistribution permission for someone else's deck. The manual separately describes AnkiWeb shared decks as material uploaded by deck sharers; that workflow also does not state a universal license for each deck.

The official Anki source tree contains package fixtures at `pylib/tests/support/` (`diffmodels2-1.apkg`, `diffmodels2-2.apkg`, `diffmodeltemplates-1.apkg`, `diffmodeltemplates-2.apkg`, `media.apkg`, `update1.apkg`, `update2.apkg`). In the source tree listing and relevant repository license, I found no fixture-specific provenance or redistribution manifest. Their presence in the Anki repository alone is not enough to attribute their embedded user-authored content or to establish reuse terms for a different project.

### Recommendation for this corpus

Author minimal, synthetic notes, templates, scheduling states, and media specifically for this project. Record the exact Anki release tag and commit, export command/options, fixture purpose, content authorship, and an explicit fixture-content license/permission in a neighboring manifest. Use only original text and generated media (for example, a generated tone) so no third-party deck or media permission needs to be inferred.

Prefer **on-demand package generation** from a version-pinned official Anki release when a fixture's archive embeds default/source-derived material whose redistribution terms are unclear, or when cross-version generation is required. Commit a generated `.apkg` only after its entire payload has been inspected and its non-software content has documented permission; a package produced by AGPL-licensed software is not, from these sources alone, evidence that its user-authored content is AGPL-licensed or freely redistributable. If reproducible package generation is too costly, commit only project-authored synthetic packages with the provenance and content terms recorded.

The sources do not settle whether every default note type, template, or other source-derived object serialized into an export should be treated as source code, data, or both. That boundary needs inspection of the particular package and, if a definitive legal determination is required, advice beyond this source review.

## Sources

- [Official Anki releases](https://github.com/ankitects/anki/releases) — release identifiers and latest release.
- [Anki 26.09.3 release](https://github.com/ankitects/anki/releases/tag/26.09.3) — publication date, tag, commit, and notes.
- [Official release process and version format](https://github.com/ankitects/anki/blob/main/docs/releasing.md) — calendar version scheme and release workflow.
- [Anki LICENSE](https://github.com/ankitects/anki/blob/main/LICENSE) — software license and enumerated exceptions.
- [Official Anki Manual: Exporting](https://docs.ankiweb.net/exporting.html) — package contents, export formats, options, and stated package purpose.
- [Official Anki Manual: Sharing decks](https://docs.ankiweb.net/contrib.html) — AnkiWeb sharing and privately exported packages.
- [Official Anki package test fixture directory](https://github.com/ankitects/anki/tree/main/pylib/tests/support) — fixture names; no fixture-level provenance/license manifest is present in that directory.
- [This repository's compatibility snapshot](../anki-compatibility.md) — current package evidence and recorded `anki==26.9.3` engine identifier.
