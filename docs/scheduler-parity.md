# Scheduler parity target

The comparison target for issue #94 is official Anki **26.9.3**, scheduler **V3**,
with **FSRS-6** enabled. The oracle uses Anki's built-in 21 default FSRS parameters,
0.9 desired retention, short-term FSRS learning enabled, learning steps of 1 and
10 minutes, one 10-minute relearning step, and daily limits of 20 new and 200
review cards. These settings come from the fresh official Anki 26.9.3 profile.

Run the isolated official scheduler oracle with:

```powershell
uv run --with anki==26.9.3 python scripts/verify-scheduler-oracle.py
```

It creates and removes a temporary collection, enables FSRS-6 using the official
profile defaults, and schedules one synthetic New card with native ID
`1234567890000`. The official scheduler reports Again `<1m`, Hard `<6m`, Good
`<10m`, and Easy `8d` for that fixed card identity. For the 64 deterministic
card IDs `1234567890000` through `1234567890063`, Easy intervals span 6–10 days.
The application uses stable card-specific fuzz seeds, so a different identity
may choose another day inside the same band; the parity test requires the app's
FSRS-6 range to match the official 6–10 day range and checks a native sample
within it while requiring the short learning previews to match exactly.

The broader grade/state matrix, review ordering, gather limits, sibling-bury
behavior, and full persisted log parity still require comparison against this
pinned target before #94 can close.
