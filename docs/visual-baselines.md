# Visual regression comparisons

The critical-screen comparisons exercise the production app through visible
controls with a generated one-note Japanese vocabulary package. The suite covers the
empty deck workspace, Browse with a selected note, populated Statistics and the
export dialog in light and dark appearance. An additional viewport comparison
keeps the populated Statistics heatmap visible. Supplemental selected Browse
table and Statistics panel comparisons cover note selection/card names without
including the changing build identifier in the footer; that identifier is
neither masked nor falsified. Desktop
Chromium retains its 1280 × 720 canvas; iPhone-sized WebKit is measured at
390 × 844 using the existing Windows host-scale calibration. WebKit emulation
does not establish physical iPhone behavior.

Normal comparison:

```sh
npm run test:e2e -- --grep @visual --workers=1
```

Deliberate baseline regeneration, after reviewing an intended visual change:

```sh
npm run test:e2e -- --grep @visual --workers=1 --update-snapshots=all
```

Use an unused app/service port pair and fresh `KIROKU_RUNTIME_DIRECTORY`, as in
CONTRIBUTING.md. Both `npm run check` and the required public Ubuntu software
gate include these tests through the normal browser suite. Baselines are
platform-specific: Windows captures are never presented as Linux captures.
The normal configuration must set `updateSnapshots: 'none'`; absent baselines
must fail rather than be generated implicitly. Other unsupported environments
must report the missing baseline and their measured rendering environment.

Comparisons use `threshold: 0` and `maxDiffPixels: 0`. Every difference classified
by Playwright's comparator fails; its default antialias exclusion still applies.
No stable content is masked. The suite fixes locale to en-US, timezone to UTC,
Date to 2026-10-07T12:00:00Z and elapsed-review time to zero. Browser timers and
animation frames continue running. The native package has fixed Deck/Note Type
identities and a fixed Note GUID. The Node-side package builder's generated
Note/Card identities, collection/row timestamps and ZIP timestamps are normalized
to explicit fixture values through its public document API; browser clock control
alone cannot freeze the package builder. Import, note selection, review and export
options all use the real visible application controls. Screenshot capture waits
for fonts, relevant data assertions and settled paint, disables animations and
hides the caret. Chromium first retains a standard full-page preparation capture,
then compares the unchanged viewport or stable panel. A fresh-context native
capture-order control found different fractional-border raster states; the
Windows/Linux preparation control produced identical subsequent viewport pixels
across twelve fresh profiles per platform. This prepares the screenshot renderer
without masking content or relaxing the comparison. Final baselines and unchanged
repeats must still qualify the complete suite.
Bounded assertions also wait for canonical active-theme body,
heading and visible-control ink after every viewport scroll. WebKit font/paint
readiness alone does not prove descendants have applied the new theme. Intended
changes to these text colors require updating the readiness expectations as
part of the reviewed visual change. Assertions separately reject horizontal page/dialog/Browse
overflow, so cropping cannot conceal it.

Panel captures convert measured CSS rectangles into host-scaled screenshot
coordinates only on Windows WebKit. A synthetic colored-box control establishes
that conversion; ordinary locator crops on that host omit stable panel content.
The visible panel rectangle is asserted before capturing it. Desktop Chromium
and Linux retain their native coordinate scale.

Each platform/project has a committed `environment.json` next to its images.
Normal comparison requires its rendering signature: architecture,
Playwright/browser versions and revision, relevant system-font SFNT version
strings where available and exact file hashes, bundled font versions/hashes, measured viewport and
device pixel ratio, production font stacks and deterministic comparison inputs.
The deliberate regeneration command replaces both manifest and images; normal
comparison neither creates a missing manifest nor accepts an incompatible one.
Font evidence contains basenames only, without usernames, hostnames or absolute
font paths. Windows records the system font candidates for the production stacks,
including Segoe UI's `segui*` style filenames such as `seguisb.ttf` (Semibold).
Linux resolves the stack candidates through Fontconfig, including proportional
Segoe UI/system-ui and semibold candidates for Deck titles. These requests do
not establish how the browser maps `system-ui`. Install `fontconfig`
and the recorded native fonts before Linux comparison.
Linux discovery also requests Japanese 猫 (U+732B), hiragana ね (U+306D)
and a representative Cyrillic Ж (U+0416) with the corresponding language,
for proportional and monospace fallback. Family-only substitution can return
a Latin face without the Japanese glyphs. The Cyrillic request is an additional
fallback probe; the current one-note fixture contains Japanese and Latin text.
Unavailable native version metadata is explicitly marked `unreported`; the
font file hash still identifies its exact bytes. These are system stack
candidates/resolutions, not a claim that CSS stacks prove which face rendered
each glyph. The actual engine comparisons remain the rendered-pixel evidence.

Each run additionally attaches OS distribution/release, Node version, source
commit, lockfile hash, configured viewport and WebKit host scale. Kernel and
provenance fields describe the actual host; WSL Ubuntu and hosted Ubuntu are
separately verified and are not described as identical kernels. The rendering
signature and every pixel must still match for both real environments.
The lockfile currently pins Playwright 1.63.0 and JetBrains Mono Variable
5.3.0; the matching browser package describes Chromium 153.0.8010.12 (revision
1243) and WebKit 26.6 (revision 2359). Japanese and heading text use the existing
system font stacks in `src/styles.css`. The rendering signature records
`--font-ui`, `--font-jp` and the proportional Deck-title token `--font-deck`
directly from the rendered root. A source revision without `--font-deck` records
an empty string; it must not substitute a proposed stack. The #93 Deck-title
change uses `'Segoe UI', system-ui, var(--font-jp)`; baseline capture must wait
until that change is integrated into the stable source being verified.
Operating-system font differences
require separately verified platform images. Do not change the production font
stack merely to make screenshots agree across operating systems.

For a failed comparison, Playwright writes expected, actual and diff images in
the local test output and links them from the HTML report. Preserve evidence
under an ignored `runtime/` directory before another run replaces that output.
To prove detection, temporarily change one stable palette/layout value, run the
normal comparison command and retain the failing log and image triplet. Restore
the value, rerun the same command and retain its passing log. Then repeat the
unchanged comparisons at the final commit and run the complete software gate.
Record exact commits, commands, durations, counts and evidence paths on #77 and
its pull request; independent Standards/Spec review and `npm run premerge`
remain required. No Actions artifact or cache upload is needed: the required
hosted gate uses free standard public runners and retains diagnostics in logs.

This document describes the verification procedure; acceptance evidence belongs
in the tracker only after the Windows and Linux captures and comparisons have
actually run.
