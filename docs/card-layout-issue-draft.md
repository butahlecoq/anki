Imported cards scroll inside a fixed-height frame instead of fitting the available space. The ivse.apkg kanji templates use 200px characters; the reviewer provides a 260px iframe with no content measurement or scaling.

Acceptance criteria:
- Oversized card layouts scale down to fit available width without horizontal scrolling.
- Frames grow to their rendered content height, avoiding an independent vertical scrollbar.
- Front/back changes, image loads, and viewport resizing update the layout.
- Preserve template CSS and sandbox restrictions; never enable imported scripts.
- Verify desktop Chromium and phone-sized WebKit with a synthetic oversized template, without committing private packages.

Related compatibility finding: imported field HTML is normalized to plain text, losing ivse answer columns. This is separate from frame sizing and excluded from this fix.
