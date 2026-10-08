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

Chromium uses actual browser-context offline mode for both persisted-profile
reopenings. WebKit's supported warm stage aborts HTTP and HTTPS requests while
the actual PC service is stopped. A reduced native-widget control shows that
WebKit `setOffline(true)` also rejects local SVG blob icons inside its native
audio controls: all ten failed URLs load as SVG again when networking is
restored, without any application or collection code. The HTTP-disruption
control verifies an actual TCP request fails while local widget icons remain
available. This is a named emulation boundary, not a global network-disable
or physical-Safari result. The journey keeps its audio sources, image decoding,
WAV inventory hashes and strict request/console guards intact.

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

Phase guards reject uncaught exceptions, severe console errors, HTTP/request failures,
unloaded media, blank loading shells, unnamed visible controls, and document
overflow. Failed service-origin requests while intentionally offline are recorded
as expected. WebKit native audio controls also emit a measured sandbox warning
in script-free card documents. That exact warning is expected only with zero
JavaScript arguments and an empty, zero-line/column location, and after a
delivery-time audit finds native WAV audio controls and verifies every live
child document and retained authored frame source. A parent-document mutation
observer, installed before interactions, retains added/removed frame sources
and previous sandbox/srcdoc values: native control messages may arrive after
review navigation removes a frame. The audit parses those retained sources
without executing them, checks nested frames, and rejects any unsafe source
observed during that document's lifetime. Every audited frame must be readable,
use the script-free `allow-same-origin` sandbox, and contain no scripts,
executable attributes or embedded objects. Missing or unverifiable evidence
fails closed; removal alone cannot erase a script-bearing frame. All warnings,
console argument/location metadata and audit results remain
in the diagnostic attachment; identical application console text and attempted
template code remain fatal. Guards await the audit before checking results.
Playwright owns tracing for every context. Traces retain
actions, screenshots and sources with DOM snapshots disabled: snapshot injection
attempts scripts in the deliberately script-free card sandbox and produces
instrumentation console errors. The native audio warning has separate positive
and negative controls with snapshots disabled, including safe and script-bearing
frames removed before the audit, and dynamic script insertion. Screenshots,
browser traces for every owned context, JSON
diagnostics, service logs, fixture bytes/hash, media digests, build identity,
actual engine version, configured/measured viewports, phase duration, and final
inventory are retained under Playwright's `test-results` output. The negative
controls independently exercise exception, console, HTTP/network, blank shell,
control-name, overflow, broken media, and damaged semantic inventory failures.

Windows WebKit phase screenshots capture the calibrated learner viewport.
A synthetic colored-marker control verifies that its full-page capture clips
off the right marker while the viewport capture retains it, even though the
DOM viewport and resize telemetry stay unchanged. Desktop Chromium and Linux
keep full-page captures. The report records the screenshot mode for each phase;
a viewport image is not presented as a full-page or physical-iPhone capture.
Imported collection screenshots wait for the restored Japanese deck control.
The journey closes support details after its separate build-identity capture,
scrolls the relevant collection/result/statistic into view, and retains an
additional phone editor capture showing its save action.
Review captures observe the child's loaded document, font status and fitted
iframe height from the parent, then await parent animation frames. The retained
negative control times out when readiness callbacks run in the script-free
child realm. Card script permissions and diagnostic guards stay unchanged.
Chromium additionally retains a native iframe close-up before each review page
capture. A same-checkpoint control records identical readable DOM/geometry with
a blank first full-page capture, followed by rendered viewport, iframe and
full-page captures. Capturing the settled iframe first retains both the Japanese
card close-up and the subsequent rendered page image. Windows WebKit keeps its
calibrated viewport captures.

Retain the command output and JSON report for pass/fail/skip/retry counts and
artifact paths; retain the HTML report when that reporter is enabled. Then run
the **entire** `npm run check` at the same final commit
with the qualification flag and private ports/runtime still set, and obtain
independent Standards/Spec review. Record the exact commands, start/end/duration,
commit, counts, and artifact paths on the issue and PR. Browser source preparation
or a focused pass cannot establish the complete software gate.

Each public export also records its named phase, package-ready message, native
download event and read-file byte count/digest as `release-export` JSON in the
job log. Package readiness and native delivery are both required; a ready message
alone cannot replace the download or semantic inventory checks. This distinguishes
the observed application and browser boundaries when a download wait fails.
Failure records retain the visible Preparing/disabled state, public result and
alerts, plus the original exception and an absolute timestamp. If the page has
ended, an unavailable observation is recorded without replacing that exception.
The existing classified network/console observations also appear as
individual `release-diagnostics` JSON records in job logs; an empty list explicitly
records no observations. Native frame-audit verdict/counts accompany each event,
with full audits retained in the artifact attachment. Classification and fatal-error
assertions remain unchanged.
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
