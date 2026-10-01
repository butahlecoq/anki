# Kiroku

Kiroku is a private, offline-first Japanese flashcard workspace with local collection editing, FSRS review scheduling, and PC-to-phone collection sync.

## Requirements

- Node.js 22 or newer
- npm 11 or newer

No Mac, Apple Developer membership, or paid service is required.

## Run locally

```powershell
npm install
npm run dev
```

Open the URL Vite prints. Development mode listens on the local network so another device can connect when the host firewall and secure-context requirements are satisfied.

## Run the production build

```powershell
npm install
npm start
```

`npm start` type-checks and builds the application before serving it at `http://localhost:4173`. Localhost is suitable for desktop verification. Installing the PWA on an iPhone will require trusted HTTPS; that production deployment is tracked by [Issue #24](https://github.com/butahlecoq/anki/issues/24).

## Run the sync service

For local desktop verification, start the durable SQLite-backed service and print a one-time pairing code in a second terminal:

```powershell
npm run server:start
npm run server:pair
```

The default service listens only on `127.0.0.1:4174`. To pair a phone across the network, provide a trusted TLS key and certificate, an HTTPS app origin, and a network host:

```powershell
$env:KIROKU_HOST = '0.0.0.0'
$env:KIROKU_TLS_KEY_PATH = 'C:\certs\kiroku-key.pem'
$env:KIROKU_TLS_CERT_PATH = 'C:\certs\kiroku-cert.pem'
$env:KIROKU_ALLOWED_ORIGIN = 'https://study.example.net'
npm run server:start
```

Enter the service’s `https://` address and the one-time code in **Connect a PC**. Credentials remain in that browser’s local collection settings and are never included in the web build.

## Progress statistics

Open **Statistics** from the desktop sidebar or the iPhone navigation bar. The home dashboard counts cards available now using the same queue as the reviewer, including daily limits, suspended cards, buried siblings, and renderable templates. **Studied** counts answers today, including repeated learning steps.

Daily, weekly, monthly, and all-time views summarize recorded answers, distinct cards, measured review time, and observed recall. Study days start at local midnight; weeks start Monday and months follow the local calendar. Recall is the share of review-state answers rated Hard, Good, or Easy; learning steps are excluded. The heatmap opens a selected day's answers and card histories. Difficulty and interval distributions describe current active scheduled cards. The 30-day forecast uses their current due dates, counting overdue cards today; future answers, new cards, and daily limits can change that workload.

New reviews measure active time while the card is visible, excluding background tabs and maintenance dialogs, capped at 60 seconds per answer. Imported Anki logs retain their recorded answer time. Older Kiroku logs without time remain unmeasured, and the view shows timing coverage. Statistics read the local database, update after offline answers and undo, and count each durable review identity once after synchronization.

## Offline media

Basic notes accept PNG, JPEG, and WebP images up to 10 MB, plus MP3, Ogg, and WAV audio up to 20 MB. Choose whether an attachment belongs on the front or back; audio can play automatically or through its built-in controls. Imported media is attached to the template side that references it. Kiroku verifies a SHA-256 digest before storing an attachment, stores identical bytes once per collection, and transfers the blob separately from card changes. A successful sync leaves verified media in the browser database, so reviewed cards keep displaying and playing after an offline restart.

Template images and audio are prepared as local data URLs so answer reveals can render new media without a network request. Preparation reads one attachment at a time, reuses duplicate content and question/answer sources, and releases them when the card closes. Unique inline media for one active card is limited to 64 MiB, in addition to the per-file limits; a visible error asks you to remove attachments or split the note if it exceeds that budget. There is no collection-wide data URL cache. Installed-iPhone cold reopening and audible playback still need physical confirmation before release.

### Image Occlusion

The built-in **Image Occlusion** note accepts a PNG, JPEG, or WebP source image. Draw rectangular masks over the image; their coordinates are normalized to the source dimensions, so the rectangles scale with the image. Each mask creates one card. On the front, every mask is covered. Showing the answer reveals only that card's active mask while the other masks stay covered.

Use **Header** for prompt context, **Back Extra** for answer-side context, and comma-separated tags to organize the note. Each saved mask has a stable ID and never-reused ordinal: moving or resizing it retains its card and review history, while deleting it suspends that card. Source images sync as verified media and the supported persistent browser-profile test covers opening an image-occlusion card after a cold offline restart.

The native interchange fixture and package importer cover the rectangular hide-one subset only. Ellipses, polygons, groups, and hide-all behavior are unsupported. Anki package export is tracked separately in [Issue #16](https://github.com/butahlecoq/anki/issues/16).

## Import Anki packages

Choose **Import Anki package** on the collection screen to preview a local `.apkg` or `.colpkg`. Kiroku reads legacy schema-11 and current schema-18 packages, including modern zstd-compressed collections and media indexes. The preview counts decks, note types, notes, cards, reviews, and media, shows the duplicate policy, and lists every compatibility finding before one IndexedDB transaction commits the package.

Package imports are limited to **128 MiB compressed**, **256 MiB expanded in total**, **64 MiB per entry**, and **20,000 archive entries**. The expanded limits cover both ZIP extraction and nested Zstandard data. Zstandard decoder windows are capped at 64 MiB each and 256 MiB in total requested allocation, with at most 20,000 frames per archive. Validation rejects unsafe or duplicate paths, inconsistent sizes, damaged payloads, ambiguous directories, encrypted archives, ZIP64, and split archives before the collection or media is parsed. Split larger decks into smaller packages or re-export unsupported archive formats. Rejection leaves the local collection and pending sync changes untouched.

Stable Anki note GUIDs become stable local identities. A first import creates the note; a later package updates it only when the package note is newer, while a newer local edit wins. Review identities are imported once, and an older package never overwrites newer local card scheduling. Nested deck paths, tags, card state, due state, counters, FSRS stability/difficulty when present, and supported review history are mapped explicitly. Packages without FSRS memory retain their Anki interval as fallback stability and report that downgrade.

Supported package templates use the documented template subset below, including Basic/reversed, cloze, multiple templates, furigana filters, typed answers, and isolated CSS. PNG/JPEG/WebP and MP3/Ogg/WAV references in note fields become offline media attachments. Native rectangular image-occlusion notes map to the built-in image-occlusion model. Unsupported filters, malformed templates, missing media, unsupported scheduler events, non-rectangular occlusions, and unreferenced static media appear in the import report; errors disable import instead of allowing silent partial loss. Export and broader compatibility proof remain tracked by Issues #16 and #25.

## Note types and card templates

Open **Note types** to create a reusable set of fields and card templates. A **Standard** type creates one card per template whose front uses a nonblank field or typed-answer prompt. A **Cloze deletions** type creates one card per distinct deletion number in its cloze field. The note editor shows the card count and why a card is skipped. If a card becomes ineligible, it is suspended from review; restoring its content restores the same card and review history.

Templates support HTML, CSS, and this small replacement syntax:

| Syntax | Effect |
| --- | --- |
| `{{Field}}` | Insert a field value by its displayed name. Field values are escaped and shown as text, including any HTML they contain. |
| `{{text:Field}}` | Insert the escaped field text. |
| `{{furigana:Field}}` | Render `漢字[かんじ]` as ruby text with a reading. |
| `{{kana:Field}}` / `{{kanji:Field}}` | Use the reading or base text, respectively, from annotated text. |
| `{{cloze:Field}}` | Mask the active deletion on the front and reveal it on the back of a cloze card. |
| `{{type:Field}}` | Ask for a typed answer using the field value. |
| `{{type:cloze:Field}}` | Ask for the active cloze deletion as a typed answer. |
| `{{#Field}}…{{/Field}}` | Include content when the field has a nonblank value. |
| `{{^Field}}…{{/Field}}` | Include content when the field is blank. |
| `{{#c1}}…{{/c1}}` / `{{^c1}}…{{/c1}}` | Include content on cloze ordinal 1, or on other ordinals, respectively. |
| `{{FrontSide}}` | Insert the rendered front on the back of the card. |

`{{FrontSide}}` is available only on the back. Conditional sections cannot be nested or filtered. A field whose exact name contains `:` remains available as `{{that:name}}`; an exact field name takes precedence over filter parsing. Unknown fields, unsupported filters such as `{{type:nc:Field}}`, and malformed delimiters produce an error. Template HTML and CSS render in a sandboxed frame, so their styles stay inside the card and scripts cannot access the app. Field values are escaped, and Basic notes retain their image and audio attachments in review.

### Cloze notes and Japanese readings

A cloze field uses `{{cN::answer}}` or `{{cN::answer::hint}}`, where `N` is a positive integer. For example, `{{c1::東京::city}}に{{c2::行く}}` creates cards `c1` and `c2`; the front of `c1` shows `[city]に行く` and its back reveals `東京`. A deletion without a hint shows `[…]`. Repeating `c1` in the same note makes one card that masks both `c1` deletions. Numbers may have gaps: `c1` and `c3` create two cards. The editor's **Make cloze** button wraps selected text with the next number; existing deletion numbers can also be edited directly. A cloze type has one template, with the same `{{cloze:Field}}` reference once on its front and once on its back. Preview lets you select an ordinal and side.

The supported grammar does not include nested deletions or multi-ordinal markers such as `{{c1,2::answer}}`. A deletion needs a nonempty answer and at most one optional hint. Malformed or unclosed deletions show an error in the editor and do not save a partial note edit.

Reading filters recognize a base beginning with one or more Han characters, optionally followed by hiragana or katakana, immediately before `[reading]`. For example, `私[わたし]は猫[ねこ]` becomes `私` and `猫` with separate ruby readings; `は` stays outside both annotations. `kana:` produces `わたしはねこ`, while `kanji:` produces `私は猫`. Unannotated text stays as entered. Bracket text without a matching Han-based annotation stays escaped text.

Place `{{type:Field}}` or `{{type:cloze:Field}}` on the front to enable a typed response. A typed-answer token alone is enough to make a card when its expected answer is nonblank. Use one typed-answer token on the front; a second produces an error. If an ordinal has several deletions, `type:cloze:` expects their answers joined by `, `. The input and comparison appear outside the card frame; pressing Enter reveals a grapheme-aware difference after trimming and Unicode normalization, and moves focus to its announced result. The learner still chooses a review rating. Typed input is transient local review state and is never synced.

Current-version clients sync cloze note types, deterministic per-ordinal cards, and review history. A removed ordinal suspends its card; restoring it retains its schedule. The sync service uses protocol v2: the device declares collection schema 13, and `/api/health` reports the collection’s durable schema watermark and the service’s supported maximum (currently 13). Before it uploads media or acknowledges operations, the app preflights that endpoint. A service rejects an incompatible sync batch before adding any change, moving its cursor, or changing the watermark. Update the device app when the collection needs a newer schema; update the PC service when it cannot support the device’s schema. In both cases local changes stay on the device for retry after the update. Malformed synced templates are contained in the reviewer as a card error with **Skip card** and **End session** actions.

Removing a field with saved values requires choosing **Keep as retired data** or **Discard saved values**. Retired values remain on the note under **Retired fields** and no longer fill templates. Deleting a note type used by notes requires a replacement type and an explicit mapping for fields you want to carry over; unmapped values are kept as retired data. Renaming a field updates its template references while preserving its saved values.

## Deck hierarchy and scheduling options

Decks can be nested. A parent deck’s counts and study session include all of its descendants, while each deck still applies the daily limits from its own scheduling option group. Use **Create child deck** or **Move deck** to organize the tree. Moving a note moves its generated cards with the same IDs and scheduling data; recorded reviews stay intact.

Open **Scheduling options** on a deck to reuse an existing group or create one. A group controls daily new and review limits, desired retention, learning and relearning steps, and new, review, and interday-learning order. It can bury new or review siblings until the next local study day after one of their note-mates is answered. Set a leech threshold, a tag, and whether crossing that threshold also suspends the card. The dialog lists every deck that uses the selected group. Saving changes affects future scheduling decisions only; it never rewrites cards or review history.

Use **Manage cards** beside a note to resume a manually suspended card, unbury it, or set its next due time. The reviewer also has **Suspend card** and **Bury card** actions; either one refreshes the session queue immediately. These lifecycle controls retain card identity, scheduler data, and review history. Cards suspended because their template no longer generates content remain unavailable until that content is restored.

While reviewing, you can edit or move the current note, change its tags, mark it, choose a colored card flag, inspect card details, and replay attached audio. **Delete note** removes the note with its cards, review history, and media references. **Undo last review** restores the prior schedule and review log, including sibling burial and leech effects; **Undo note deletion** restores the deleted note and related records. **Undo card action** reverses the latest flag, bury, or suspend action. These local undo actions are available until the next sync attempt or a conflicting edit. Reviewer shortcuts are shown above the card; the same actions are available as touch controls.

Deleting a deck always asks how to handle its contents. **Relocate contents and child decks** moves the deck’s direct notes and children to a selected destination, then removes the source deck. **Delete this deck and its subtree** permanently removes the whole branch and its contained study data.

## Collection browser

Open **Browse** from either navigation bar. Switch between cards and notes, sort the result columns, and use pages of 50 rows. Search, view, sort, and separate card/note selections persist on this device. Selection follows record IDs across sorting and reload; selected records outside the current search still receive bulk actions.

Text searches note fields using normalized Japanese/Latin text. Spaces mean AND; use `OR`, parentheses, a leading `-`, and double quotes for values containing spaces. Supported filters include `deck:Japanese` (including children), `tag:jlpt::*`, `note:"Basic reversed"`, `card:Recognition`, `flag:3`, `is:due`, and states `new`, `learn`, `learning`, `relearning`, `review`, `suspended`, and `buried`. Name/tag filters accept `*` and `?`. `due:<2026-10-01` and `reviewed:2026-10-01` use local calendar dates and accept comparison operators. `rated:7:1` finds Again answers within seven local days; ratings 1–4 are Again/Hard/Good/Easy. Invalid syntax shows its position while retaining the last valid results.

Tag, move, and delete actions affect the selected notes and every generated sibling card. Flag and suspension actions affect selected cards, or all cards of selected notes. Deletion shows affected counts and requires confirmation. Multi-record maintenance does not expose a misleading partial undo. All changes and sync operations commit together or roll back together.

**Find / replace / edit** selects one note type and field, offers literal, JavaScript Unicode regex, or entire-field replacement, and requires a before/after preview and confirmation. Literal replacements keep dollar signs literal; regex replacements support capture references. Previews allow up to 5,000 notes or 8 MiB and stop expensive patterns after two seconds in a separate worker. Edits preserve existing card identities and review history; a changed note or type invalidates its preview.

The duplicate report matches a note type and normalized first field. The empty report finds empty fronts and missing templates; Notes view also includes notes without generated cards. Open an expression to edit the affected record. Image occlusion uses its dedicated editor.

## Verify

Install the Playwright browser engines once:

```powershell
npx playwright install chromium webkit
```

Run every current check:

```powershell
npm run check
```

The browser suite builds the production app, starts it locally, then verifies desktop Chromium and phone-sized WebKit. Statistics are exercised offline in both engines; a separate Chromium test opens a fresh document offline and reads the stored answers. Playwright [supports service workers only in Chromium](https://playwright.dev/docs/service-workers), so the fresh-document statistics test explicitly skips WebKit. Automated phone-sized WebKit checks do not prove that an installed iPhone app reopens offline: verify that on physical Safari before release.

## Privacy

Imported packages, Anki databases, media, runtime data, backups, environment secrets, and generated certificates are ignored by Git. Do not commit a real collection or identity-bearing fixture.

## Agent collaboration

Read `CONTRIBUTING.md` before claiming a ticket. Each agent must claim one unblocked GitHub issue and use its own branch and worktree; agents must not edit the same working directory.
