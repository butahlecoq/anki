# Rules live in modules, not in the adapter that stores them

An architecture review of kiroku found one repeated shape behind most of the
defects in this repository: a rule that belongs to the domain was written
inside the module that happens to also do storage, and then re-derived wherever
it was next needed. The duplicates drifted.

## Context

Seven instances were found, of four kinds:

- **One concept, several interfaces.** Undo was three types under three private
  settings keys, each restating the same four-step guard protocol, with two
  modules outside the Collection reaching past it to write those keys by hand.
- **The same fact in several homes.** The collection schema version was a bare
  literal in three places and the server's per-operation minimum was a
  hand-transcribed mirror of the migration ladder, with nothing asserting they
  agreed.
- **Derivation without an owner.** "Can this card be shown?" was re-derived by
  six modules. "Is this card eligible to study?" existed in four, three of them
  slightly different.
- **Two directions of one Exchange, written independently.** Import and export
  each re-derived the media type mapping, byte reading, digesting, native state
  tables and the package identity scheme. Five concepts had three or four
  copies.

The pattern matters more than any single instance. A defect like the deck
identity bug in ADR 0001 was possible because the same rule existed in two
places and only one was fixed. Nothing about the codebase was checking.

## Considered options

**Fix each duplicate where it is found.** Rejected. It produces the same result
the repository already has, one instance at a time, and leaves nothing that
prevents the next divergence. The two `isRenderedCardEmpty`-style seams that
were introduced by a well-meant refactor in this very effort were themselves
identity functions that shared nothing.

**Adopt a general rule that modules must not duplicate logic.** Rejected as
unenforceable. There is no check here that can see a rule restated in two
places; writing one down in `CONTRIBUTING.md` would have been an assertion
rather than a constraint.

**Give each concept one owning module, and make the owning module the only
place the rule exists.** Chosen.

## Consequences

- The rule is stated once, in a module whose name is the rule: `scheduler.ts`
  owns Study Eligibility, `undo.ts` owns the undo guard protocol,
  `schema-ladder.ts` owns the schema ladder, `card-rendering.ts` owns card
  displayability, `media-types.ts` owns the media type table.
- Storage adapters keep the I/O and delegate. `Collection` is one adapter
  behind these seams, not the place the rules live.
- **The seam must contain the whole rule or it is worse than none.** A shared
  function that returns a field unchanged, while each caller still applies its
  own exception, makes the duplication harder to see rather than removing it.
  This is the specific failure mode that had to be caught by review twice in
  this work.
- Where a rule cannot be moved whole, the seam says why it cannot. Two server
  rules are stated explicitly rather than derived - a note type's `kind` is a
  discriminator, not a field presence test - and the test that guards them
  carries the cases the previous hand-written rules got right, so the
  derivation is verified rather than assumed.
- The guards are tests over the *absence* of duplication, not just the presence
  of behaviour. `undo-seam.test.ts` reads the source to assert that no module
  names an undo record by key, because the property is about which keys a
  caller may name and no runtime test can observe a violation after the fact.

## Scope

This decision covers where a rule lives. It does not yet cover the interface
around storage: `Collection` still extends Dexie, so twelve table properties
and the database library's own surface remain reachable by every caller. That
is a separate, larger change, tracked by #110, #111 and #112, and it is
attempted only after these seams are stable - not because it is unimportant,
but because every step of it touches code that was being moved at the same
time.