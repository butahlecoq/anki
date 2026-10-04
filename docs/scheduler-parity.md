# Scheduler parity target

The comparison target for issue #94 is official Anki **26.9.3**, scheduler **V3**,
with **FSRS-6** enabled. The oracle uses Anki's built-in 21 default FSRS parameters,
0.9 desired retention, short-term FSRS learning enabled, learning steps of 1 and
10 minutes, one 10-minute relearning step, and daily limits of 20 new and 200
review cards. These settings come from the fresh official Anki 26.9.3 profile.
The profile's study day rolls over at 4:00 a.m. local time (Anki's default).

Review fuzz uses Anki's deterministic card-ID-plus-review-count seed and the
`rand 0.9.4` `StdRng` draw (ChaCha12). A persisted New card with ID
`1234567890000`, zero prior reviews, and the matching default profile previews
and persists an 8-day Easy interval in both Anki and the app. This checks the
exact native draw as well as the broader native interval bands below. The oracle
emits all 64 Easy intervals for IDs `1234567890000`–`1234567890063`; the app test
uses those same IDs and compares every preview, persisted card interval, and
persisted review after-state with the native result.

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

Sibling burial now has separate new, review, and interday-learning controls.
The app follows Anki's gather precedence (intraday learning, interday learning,
reviews, then new cards): only siblings at the same or a later queue stage can
be buried. Intraday learning siblings are never buried. The pinned oracle checks
that same-stage review and interday-learning siblings are buried when enabled,
while two intraday-learning siblings remain available.

The app now uses the same 4:00 a.m. local rollover for daily limits, daily shuffle
seeds, sibling burial, and statistics. App tests cover all 16 state/grade
transitions, preview-to-answer agreement, persistence after reload, review sort
modes, gather modes, and cross-type bury precedence. The pinned native oracle
checks the default review and new-card schedules plus the queue, limit, and
burial cases above. It also emits the official persisted card rows (including the
native card data field) and review-log rows for all 16 state/grade combinations.
Each outcome also includes the native four-grade preview labels from that same
pre-answer state.
Those native outcomes still need to be compared with the app's persisted outputs
for Learning, Review and Relearning across all four grades, and extended to every
alternate sort/gather mode directly against Anki, so #94 stays open for that
remaining parity evidence. The current Review fuzz path also remains approximate:
Anki constrains its draw using the previous scheduled interval before drawing,
while the app uses stored elapsed days and clamps the sampled result afterward.
The native-output matrix must compare those Review cases before claiming parity.
A user-configured Anki rollover hour is not yet a setting in the app; this target
currently matches Anki's default.
