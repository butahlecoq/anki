# Offline verification

## Automated evidence

The production browser suite separates these outcomes:

| Outcome | Chromium | Phone-sized WebKit |
| --- | --- | --- |
| Existing document continues without a network | Shell, imported/synced media, Japanese review, statistics | Same warm journeys |
| Fresh offline document loads persisted data | Shell, imported/synced media, scheduling, statistics | Explicitly skipped |
| Closed browser profile restarts offline | Japanese scheduling, synced media, image occlusion, cloze | Explicitly skipped |

Fresh reloads require a successful main-document response served by the service worker and loss of a marker placed on the preceding document. A profile restart requires the old browser context to be closed, a new persistent context to start at `about:blank`, and successful service-worker navigation. Assertions then check visible Japanese content, saved review counts, remaining cards, decoded images, and audio metadata where supported. No offline navigation exception is swallowed.

Playwright documents service-worker automation as [supported only in Chromium](https://playwright.dev/docs/service-workers). Its WebKit port also has limited audio support. Warm WebKit checks establish offline use of an already loaded app; they do not establish a fresh installed Safari launch, browser storage retention after termination, or actual audio playback. A successful Chromium run cannot substitute for the physical checks below.

Statistics has its own fresh-page journey; collection browsing needs its visible offline operations included when that feature lands. CI must be recorded against the precise PR commit, with skips listed separately. A green check proves the covered automated cases, not the physical checklist.

## Physical installed-iPhone release checklist

These checks remain **outstanding** until a person records device/iOS version, build commit, commands/deployment, screenshots or video, and results in compatibility issue #25 and release issue #26.

- Install the production app through Safari on trusted HTTPS using Add to Home Screen. Import or create Japanese cards, including furigana, cloze, image occlusion, image/audio, and multiple cards for subsequent reviews; synchronize with the PC.
- Record notes, tags, review counts, remaining queue, media, statistics totals, and browser search/bulk edits. Close the installed app, stop the PC service, enable airplane mode, and disable Wi-Fi.
- Cold-launch from the Home Screen. Confirm a fresh launch completes without a blank page, network requirement, missing Japanese text, lost edits, or changed counts. Play the cached audio audibly and inspect decoded images and image occlusion.
- Complete multiple reviews, inspect statistics and heatmap, search Japanese material, perform a supported browser edit/bulk action, and confirm the stored results. Close the app again and cold-launch while still offline; check those changes and remaining scheduled cards persisted.
- Restore networking and the PC service, synchronize, and confirm both devices converge without losing offline reviews, browser edits, statistics history, or media. Exercise export/re-import and restore as required by the release checklist.

Do not mark these checks passed based on a surviving tab or a failed reload that leaves the previous DOM visible. Safari remote inspection can help diagnose failures; final acceptance requires the installed app's observed behavior.
