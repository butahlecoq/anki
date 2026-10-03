# A Synthesised Deck's identity is derived from its Deck Path

A package can name a deck only inside a Deck Path, with no row of its own. kiroku
creates that Deck so the learner has a usable hierarchy, and because the package
supplies no Native Identity for it, the app derives one: a deterministic number
from the Deck Path, expressed in the same `anki-deck:<number>` scheme as a deck
that arrived from a package. Exchange is then a fixed point rather than a one-way
ratchet — export writes the derived number, and a re-import reads it back as the
same identity.

## Context

Deck identities are referenced by notes, cards, review entries, statistics and
the sync outbox, so this decision is expensive to revisit: changing the scheme
later costs user data rather than effort.

Anki's deck format has no way to express "this deck has no identity" — every deck
written to a package has a number. So a Synthesised Deck's identity must be
chosen by kiroku at import time, and must be reproducible by export, or the deck
is renamed on the round trip and everything referring to it goes stale.

## Considered options

**Persist a native identity on Decks, as notes and cards already do.** Decks would
grow an `ankiId` field, import would set it, and export would use it in preference
to deriving one. This is the existing precedent, and it is genuinely what notes and
cards do. It was rejected because it does not achieve what is needed: the local
identity still changes on the *first* round trip, from the derived form to
`anki-deck:<number>`. It stops the change after one lap rather than preventing it,
and it leaves the collection's own identity scheme with two forms forever.

**Patch export to recognise the legacy `anki-deck-path:<encoded>` form.** The
smallest possible diff. Rejected because it provably changes nothing: whatever
number export writes, a re-import finds a row for that Deck Path and assigns
`anki-deck:<that number>`, which is not the legacy form. The bug survives the fix.

**Derive the identity from the Deck Path, in the deck scheme** — chosen.

## Consequences

- `anki-deck:<number>` becomes the only identity form the app emits for decks,
  matching the `anki-<kind>:<native>` shape every other entity uses. The
  `anki-deck-path:` form is gone.
- Export needs no new case. It already reads the number out of a deck identity;
  a derived identity *is* a number in that scheme.
- The derivation is the same deterministic hash notes and cards already use, so
  there is one rule rather than two. Its range overlaps the millisecond-timestamp
  range Anki uses for deck identities, so a collision remains improbable rather
  than impossible. This is accepted knowingly, for parity with the existing
  scheme; a reserved disjoint band would remove the hazard at the cost of a
  second derivation rule.
- The derivation is a pure function of the Deck Path, so two devices importing
  the same package agree. Probing for an unused identity was rejected for exactly
  this reason: it would make the result depend on local collection state and let
  two devices fork a hierarchy.
- Collections imported before this decision hold the legacy form. They are
  reconciled and rekeyed at import time rather than by a schema migration. The
  migration was rejected as too broad for the defect — it would rewrite five
  tables plus the settings holding undo records, to fix a deck that in the legacy
  case is provably an empty container holding one parent pointer — and because
  the collection ladder is already ahead of the advertised schema constant, so a
  migration widens a drift another issue owns.
- Reconciliation adopts whatever deck already stands at a Deck Path, so a deck
  the learner made keeps its identity and its deck options. Only the legacy form
  and duplicates are superseded.
- A deck reconciled away is *not* necessarily empty. A Synthesised Deck is always
  an ancestor — notes and cards are assigned to the leaf of a Deck Path — so the
  legacy-form case is cheap. But a collection may already hold two decks at one
  Deck Path, and the one reconciled away can hold anything. Its notes, cards,
  reviews and undo records therefore follow the deck that survives. If a future
  feature introduces a third kind of reference to a deck, this decision must be
  revisited before the reconciliation can stay safe.
