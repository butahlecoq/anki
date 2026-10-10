# Learning Repetition Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution.

**Goal:** Match Anki's default 20-minute intraday learning fallback after due work finishes (#304).

**Architecture:** Scheduler owns eligibility and ordering. Collection adapts persisted rows and filters displayability before deciding whether due work is exhausted. The shared lifecycle continues to consume the collection queue.

**Tech stack:** TypeScript, React, Dexie, Vitest, Playwright, official Anki 26.9.3 synthetic oracle.

## Non-negotiables

- Due work retains priority; learn-ahead window is 20 minutes.
- Preserve FSRS intervals, daily limits, suspension, burial and custom-study reservations.
- Never use private learner data in committed tests or artifacts.

## Review Focus

- Due but empty fronts must not prevent learning fallback.
- Learning outside the selected subtree stays excluded.
- Relearning shares the intraday rule; interday learning stays excluded.
- Boundary at 20 minutes includes the card; later cards stay excluded.
- Early answers must retain normal history, schedule and undo behavior.

### Task 1: Queue and answer eligibility

**Files:** `src/scheduler.ts`, `src/scheduler.test.ts`, `src/collection.ts`, `src/collection.test.ts`, `src/CollectionWorkspace.tsx`.

1. Reproduce a Hard answer followed by exhausted due work in the collection test; confirm failure.
2. Compare a synthetic single-card Hard answer with official Anki; record its 1200-second learn-ahead and repeated card.
3. Add shared scheduler eligibility and ordered learning candidate selection; adapt the renderable queue only after due displayable cards are exhausted.
4. Use the rule for choices and answers; let deck study availability consume the renderable queue.
5. Add boundary, subtree, reservation, empty-front and unavailable-card tests; run focused tests and typecheck.
6. Commit the verified change.

### Task 2: Reviewer and qualification

**Files:** new `tests/e2e/learning-repeat.spec.ts`, compatibility documentation.

1. Add a browser journey proving Hard repeats without completion and later Easy finishes; run Chromium/native WebKit.
2. Document supported default learn-ahead behavior and official comparison.
3. Run the complete local gate and hosted gate; obtain separate Matt Pocock Standards/Spec reviews at final head.
4. Record acceptance evidence, run premerge, merge and remove the issue worktree in the same step.
