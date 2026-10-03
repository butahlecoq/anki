# kiroku

kiroku is an offline-first flashcard application for Japanese study. It keeps its
own collection model in the browser and exchanges collections with Anki, in both
directions, as `.apkg` and `.colpkg` packages.

## Language

**Deck**:
A named container that owns cards, and optionally a parent Deck. The unit a
learner browses, studies and exports.
_Avoid_: folder, category, pile

**Deck Path**:
The `::`-separated chain of Deck names that addresses a Deck, the form Anki
stores as one machine name. kiroku treats a Deck Path as an address; Anki treats
it as a string. A Deck Path can name a Deck that no row defines.
_Avoid_: deck name, full name, qualified name

**Native Identity**:
The numeric identity an entity carries in Anki's own formats, retained so that
exchanging a collection preserves it. Notes and cards carry theirs; Decks,
Note Types and reviews carry theirs in the app identity instead.
_Avoid_: Anki id, source id, upstream id

**Synthesised Deck**:
A Deck that a package names only inside a Deck Path, with no row of its own, and
which therefore has no Native Identity from the package. kiroku gives it an
identity derived from its Deck Path so that it can be exchanged and re-imported
unchanged. A Synthesised Deck is always an ancestor: notes and cards are assigned
to the leaf of a Deck Path.
_Avoid_: fake deck, generated deck, orphan deck, placeholder deck

**Superseded Deck**:
A local Deck that a later import reconciles away, because a deck already stands
at its Deck Path under a better identity — either one carrying the legacy form
this repo no longer emits, or a duplicate of the same path. Everything pointing
at a Superseded Deck moves to the deck that survives.
_Avoid_: deleted deck, replaced deck, merged deck

**Import Plan**:
The named, inspectable value a package import produces before anything is
written — every Deck, note, card and media row it would write, plus every issue
it found. Reviewing an Import Plan is what a learner approves; committing it is
what writes.
_Avoid_: preview, dry run, draft import, staged import

**Exchange**:
Any movement of collection data between kiroku and an Anki format, in either
direction. Import and export are the two directions of one Exchange, and share
one vocabulary.
_Avoid_: synchronisation, sync, transfer

**Custom Study Session**:
A named, ordered set of cards a learner has set aside to practise on their own,
held apart from the daily queue until answered or rebuilt.
_Avoid_: temporary cards, reserved cards, drill session

**Study Eligibility**:
Whether a card may enter a queue. One rule decides it: a card is ineligible while
its template content is suspended, while it is suspended manually, or while it is
buried. Every surface - the reviewer, the browser, custom study, workload
reporting - asks the scheduler module for that one answer rather than testing
suspension fields itself.
_Avoid_: availability, schedulable, active

## Reading further

- [ADR 0001: a Synthesised Deck's identity is derived from its Deck Path](docs/adr/0001-synthesised-deck-identity.md)
