# Production release qualification

Issue [#26](https://github.com/butahlecoq/anki/issues/26) qualifies the production
web application against a real PC collection service with synthetic data. The
journey source is not acceptance evidence until it has run on the final commit.
Resolve the issue's open dependencies before final qualification.

In the issue's isolated worktree, install the pinned dependencies and engines,
then choose unused loopback ports. Never reuse or stop someone else's service.

```powershell
npm ci
npx playwright install chromium webkit
$env:KIROKU_WEB_PORT = '4683'
$env:KIROKU_SYNC_PORT = '4684'
$env:KIROKU_RUNTIME_DIRECTORY = "$PWD\.runtime\release-gate"
$env:KIROKU_RELEASE_QUALIFICATION = '1'
npm run server:build
npx playwright test tests/e2e/release-journey.spec.ts tests/e2e/release-oracles.spec.ts --workers=1
```

The qualification flag makes Playwright refuse existing preview/service servers.
The preview builds production assets. The integrated journey independently reads
the expected Git HEAD and checks the visible support details, web manifest, and
its own compiled PC service health against that identity. Its service binds an
ephemeral loopback port and stores only synthetic data in a freshly created
temporary directory. Stop/restart preserves that directory, collection
generation, device pairing, operations, and media; cleanup deletes it only at
the end. Inherited TLS/host settings cannot point this test at a private service.

The browser journey imports an authored nested Japanese package with three
image/audio cards, creates and studies another note through the editor, pairs a
clean second client, studies, and synchronizes. With the owned service actually
stopped, Chromium closes its persisted profile and launches it offline. It
decodes retained images/audio metadata, records two reviews, edits a field,
searches, and checks Statistics. After another closure/offline launch it checks
the retained reviews and edit, opens the actual card through a visible custom
practice session, verifies media and the edited answer, and deletes that temporary
session without a rating. Offline exports before/after the second reopening
compare the whole supported package inventory. Reconnecting the same service
must preserve all changes and converge with the second client after reload. A
third clean client imports the final export, reloads, searches, and re-exports it.

The semantic inventory retains decks' supported Native Identity and Deck Path,
notes and tags, full note types/fields/templates, cards' native schedules and
kiroku scheduling/review metadata, review logs, supported note creation/update
timestamps, and SHA-256 media digests. It also checks media against the original
fixture digests. It removes only native `mod`, `usn`, and `mtimeSecs` transport
revision stamps that ankipack generates at each export, and sorts media-reference
rows without dropping any property. It does not replace due dates or strip note
timestamps. Every card is rated before the roundtrip so new-card import-time due
initialization cannot obscure schedule comparisons. The current exporter emits
Deck Path and Native Identity rather than local deck option groups/descriptions;
this journey does not claim those unsupported package properties are preserved.

Phase guards reject uncaught exceptions, console errors, HTTP/request failures,
unloaded media, blank loading shells, unnamed visible controls, and document
overflow. Only failed service-origin requests while intentionally offline can be
recorded as expected. Screenshots, browser traces for every owned context, JSON
diagnostics, service logs, fixture bytes/hash, media digests, build identity,
actual engine version, configured/measured viewports, phase duration, and final
inventory are retained under Playwright's `test-results` output. The negative
controls independently exercise exception, console, HTTP/network, blank shell,
control-name, overflow, broken media, and damaged semantic inventory failures.

Retain the command output and HTML report for pass/fail/skip/retry counts and
artifact paths. Then run the **entire** `npm run check` at the same final commit
with the qualification flag and private ports/runtime still set, and obtain
independent Standards/Spec review. Record the exact commands, start/end/duration,
commit, counts, and artifact paths on the issue and PR. Browser source preparation
or a focused pass cannot establish the complete software gate.

An exploratory production-browser pass remains a separate required observation:
inspect the retained onboarding, editor/decks, question/answer, offline, sync,
Browse, Statistics, and restored screenshots; exercise narrow/wide layout,
keyboard/touch access, errors, and reload behavior; record each concrete defect
as fixed or linked to an issue. Do not label source preparation as exploration.

WebKit covers an already loaded offline session and convergence/reimport. Its
cold service-worker profile reopenings are explicitly unverified; Windows
WebKit has no audio backend, so a retained WAV source is not decoded/audible
playback evidence. Neither browser proves installed iOS behavior. The physical
iPhone installation, terminated-app cold launch, storage retention, and audible
playback checklist remains **unverified** under
[issue #24](https://github.com/butahlecoq/anki/issues/24) and
[offline-verification.md](offline-verification.md).
