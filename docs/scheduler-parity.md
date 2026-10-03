# Scheduler parity target

The comparison target for issue #94 is official Anki **26.9.3**, scheduler **V3**,
with **FSRS-6** enabled. The oracle uses Anki's built-in 21 default FSRS parameters,
0.9 desired retention, short-term FSRS learning enabled, learning steps of 1 and
10 minutes, one 10-minute relearning step, and daily limits of 20 new and 200
review cards. These settings come from the fresh official Anki 26.9.3 profile.
The profile's study day rolls over at 4:00 a.m. local time (Anki's default).

Run the isolated official scheduler oracle with:

```powershell
uv run --with anki==26.9.3 python scripts/verify-scheduler-oracle.py
```

It creates and removes a temporary collection, enables FSRS-6 using the official
profile defaults, and schedules a synthetic New card with native ID
`1234567890000`. The official scheduler reports Again `<1m`, Hard `<6m`, Good
`<10m`, and Easy `8d` for that fixed card identity. For 64 deterministic new-card
IDs, Easy intervals span 6–10 days.

The oracle also graduates 512 synthetic cards to Review, with their Easy answer
time fixed eight days before the preview check so they are being reviewed at the
scheduled interval. For the fixed first card, native Hard/Good/Easy previews are
28/41/68 days. Across the 512 identities, the native
scheduled-day bands are Hard 23–30, Good 35–43, and Easy 60–71 days. App tests
compare 64 stable card identities against those wider native bands, avoiding a
false mismatch from comparing short-term previews immediately after graduation
with due-time review previews.

The queue oracle also gives the selected parent a one-new-card limit and its child
a two-card gather limit. Anki gathers one card when the parent is selected and two
when the child is selected directly; the app now applies child gather caps first,
then the selected deck's total limit across its subtree. The app currently uses
Anki's default behavior; the optional “Limits Start From The Top” preference is
not configurable.

Anki's fresh profile uses `mixWithReviews` for both new/review and
interday-learning/review order. The native oracle gathers two new and five review
cards and verifies the default queue sequence `review, review, new, review,
review, new, review`. The app uses the same even intersperser and now exposes
separate mix/before/after settings for both queue types. Intraday learning remains
ahead of the main queue, while daily caps gather interday learning before reviews
as Anki does.

The default review limit is shared by due reviews, interday learning, and new
cards. With a daily limit of two, Anki gathers one due review plus one new card;
two due reviews leave no room for new cards, and a zero review limit suppresses
all new cards. The app applies this budget both within each deck's gather limit
and again across the selected subtree. The pinned oracle also confirms that a
selected parent with a review limit of two gathers two new cards from a child
with a higher own limit, while directly selecting that child gathers three.

The app now uses the same 4:00 a.m. local rollover for daily limits, daily shuffle
seeds, sibling burial, and statistics. The broader grade/state matrix, review
sort modes, more complex gather priority, sibling-bury behavior,
and full persisted log parity still require comparison against this pinned target
before #94 can close. A user-configured Anki rollover hour is not yet a setting
in the app; this target currently matches Anki's default.
