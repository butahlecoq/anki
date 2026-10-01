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

## Offline media

Basic notes accept PNG, JPEG, and WebP images up to 10 MB, plus MP3, Ogg, and WAV audio up to 20 MB. Choose whether an attachment belongs on the front or back; audio can play automatically or through its built-in controls. Kiroku verifies a SHA-256 digest before storing an attachment, stores identical bytes once per collection, and transfers the blob separately from card changes. A successful sync leaves verified media in the browser database, so reviewed cards keep displaying and playing after an offline restart.

### Image Occlusion

The built-in **Image Occlusion** note accepts a PNG, JPEG, or WebP source image. Draw rectangular masks over the image; their coordinates are normalized to the source dimensions, so the rectangles scale with the image. Each mask creates one card. On the front, every mask is covered. Showing the answer reveals only that card's active mask while the other masks stay covered.

Use **Header** for prompt context, **Back Extra** for answer-side context, and comma-separated tags to organize the note. Each saved mask has a stable ID and never-reused ordinal: moving or resizing it retains its card and review history, while deleting it suspends that card. Source images sync as verified media and the supported persistent browser-profile test covers opening an image-occlusion card after a cold offline restart.

The native interchange fixture covers the rectangular subset only. Ellipses, polygons, groups, and hide-all behavior are unsupported. Anki package import and export are tracked separately in [Issue #15](https://github.com/butahlecoq/anki/issues/15) and [Issue #16](https://github.com/butahlecoq/anki/issues/16).

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

Current-version clients sync cloze note types, deterministic per-ordinal cards, and review history. A removed ordinal suspends its card; restoring it retains its schedule. Sync does not yet negotiate schema capabilities with older clients. Do not sync a cloze collection with a v6 client: it may acknowledge changes it cannot represent. Mixed-version rejection and upgrade guidance are tracked by [Issue #35](https://github.com/butahlecoq/anki/issues/35). Malformed synced templates are contained in the reviewer as a card error with **Skip card** and **End session** actions.

Removing a field with saved values requires choosing **Keep as retired data** or **Discard saved values**. Retired values remain on the note under **Retired fields** and no longer fill templates. Deleting a note type used by notes requires a replacement type and an explicit mapping for fields you want to carry over; unmapped values are kept as retired data. Renaming a field updates its template references while preserving its saved values.

## Deck hierarchy and scheduling options

Decks can be nested. A parent deck’s counts and study session include all of its descendants, while each deck still applies the daily limits from its own scheduling option group. Use **Create child deck** or **Move deck** to organize the tree. Moving a note moves its generated cards with the same IDs and scheduling data; recorded reviews stay intact.

Open **Scheduling options** on a deck to reuse an existing group or create one. A group controls daily new and review limits, desired retention, learning and relearning steps, and new, review, and interday-learning order. It can bury new or review siblings until the next local study day after one of their note-mates is answered. Set a leech threshold, a tag, and whether crossing that threshold also suspends the card. The dialog lists every deck that uses the selected group. Saving changes affects future scheduling decisions only; it never rewrites cards or review history.

Use **Manage cards** beside a note to resume a manually suspended card, unbury it, or set its next due time. The reviewer also has **Suspend card** and **Bury card** actions; either one refreshes the session queue immediately. These lifecycle controls retain card identity, scheduler data, and review history. Cards suspended because their template no longer generates content remain unavailable until that content is restored.

Deleting a deck always asks how to handle its contents. **Relocate contents and child decks** moves the deck’s direct notes and children to a selected destination, then removes the source deck. **Delete this deck and its subtree** permanently removes the whole branch and its contained study data.

## Verify

Install the Playwright browser engines once:

```powershell
npx playwright install chromium webkit
```

Run every current check:

```powershell
npm run check
```

The browser suite builds the production app, starts it locally, then verifies desktop Chromium and phone-sized WebKit. It includes a service-worker-backed offline cold reload rather than testing only a warm page.

## Privacy

Imported packages, Anki databases, media, runtime data, backups, environment secrets, and generated certificates are ignored by Git. Do not commit a real collection or identity-bearing fixture.

## Agent collaboration

Read `CONTRIBUTING.md` before claiming a ticket. Each agent must claim one unblocked GitHub issue and use its own branch and worktree; agents must not edit the same working directory.
