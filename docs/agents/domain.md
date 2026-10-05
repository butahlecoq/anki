# Domain Docs

How engineering skills should consume this repository’s domain documentation.

## Before exploring

Read:

- `GLOSSARY.md` at the repository root, when present.
- Relevant ADRs under `docs/adr/`, when present.

Missing domain files are not errors. Proceed silently. Create them lazily through the domain-modeling workflow when terminology or decisions need recording.

## Layout

This is a single-context repository:

```text
/
├── GLOSSARY.md
├── docs/adr/
└── src/
```

## Vocabulary

Use terms as defined in `GLOSSARY.md` in issue titles, specifications, tests, and implementation. Avoid synonyms that the glossary rejects. If a needed concept is absent, reconsider the terminology or note the gap for domain modeling.

## ADR conflicts

Explicitly flag any proposal that contradicts an existing ADR rather than silently overriding it.
