// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyseDrift,
  branchDispositionEvidence,
  formatReport,
  gitArgs,
  mentionsPath,
  parseArgv,
  parseLeftRightCount,
  parseNumstat,
  parseStatus,
  parseWorktreePorcelain,
  referencedNumbers,
  relandingPullRequest,
  revision,
  untrackedFilesMatchingRemote,
  USAGE,
} from './drift-check.mjs'

const inStep = () => ({
  main: { branch: 'main', behind: 0, ahead: 0 },
  primary: { path: 'D:/work/anki', branch: 'main' },
  worktrees: [{ path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] }],
  branches: [],
  pullRequests: [],
  commandLines: [],
})

const findingsFor = (input, check) => analyseDrift(input).findings.filter((f) => f.check === check)

describe('analysing a repository in step', () => {
  it('reports nothing and exits zero', () => {
    const report = analyseDrift(inStep())
    expect(report.findings).toEqual([])
    expect(report.exitCode).toBe(0)
  })
})

describe('the local main', () => {
  it('reports how far behind origin/main it is', () => {
    const input = { ...inStep(), main: { branch: 'main', behind: 3, ahead: 0 } }
    const [finding] = findingsFor(input, 'main-behind')
    expect(finding.level).toBe('drift')
    expect(finding.subject).toBe('main')
    expect(finding.message).toMatch(/3 commit\(s\) behind origin\/main/)
    expect(findingsFor(input, 'main-ahead')).toEqual([])
    expect(analyseDrift(input).exitCode).toBe(1)
  })

  it('reports unpushed commits sitting on main', () => {
    const input = { ...inStep(), main: { branch: 'main', behind: 0, ahead: 1 } }
    const [finding] = findingsFor(input, 'main-ahead')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/1 commit\(s\) not on origin\/main/)
    expect(finding.remedy).toMatch(/never commit straight to main/)
    expect(findingsFor(input, 'main-behind')).toEqual([])
  })

  it('names the primary working directory when it is not on main', () => {
    const input = {
      ...inStep(),
      primary: { path: 'D:/work/anki', branch: 'fix/94-review-replay' },
    }
    const [finding] = findingsFor(input, 'primary-not-main')
    expect(finding.level).toBe('drift')
    expect(finding.subject).toBe('D:/work/anki')
    expect(finding.message).toMatch(/fix\/94-review-replay/)
  })
})

describe('worktrees with uncommitted work', () => {
  it('reports dirty work another agent is using as in progress, not as failure', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        {
          path: 'D:/work/anki-85-baseline',
          branch: 'audit/85-current-main',
          dirtyFiles: ['src/hint.ts'],
          untrackedFiles: [],
        },
      ],
      commandLines: ['node D:\\work\\anki-85-baseline\\node_modules\\vite\\bin\\vite.js'],
    }
    const [finding] = findingsFor(input, 'dirty-worktree')
    expect(finding.level).toBe('info')
    expect(finding.subject).toBe('D:/work/anki-85-baseline')
    expect(finding.message).toMatch(/src\/hint\.ts/)
    expect(finding.message).toMatch(/something is in it/)
    expect(analyseDrift(input).exitCode).toBe(0)
  })

  it('counts the worktree the check was run from as in progress', () => {
    const input = {
      ...inStep(),
      cwd: 'D:\\work\\anki-84-drift-check',
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-84-drift-check', branch: 'feat/84-drift-check', dirtyFiles: ['scripts/drift-check.mjs'], untrackedFiles: [] },
      ],
    }
    const [finding] = findingsFor(input, 'dirty-worktree')
    expect(finding.level).toBe('info')
    expect(analyseDrift(input).exitCode).toBe(0)
  })

  it('reports dirty work with nothing in it as stranded', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-issue-94', branch: 'fix/94-review-replay', dirtyFiles: ['a.ts', 'b.ts'], untrackedFiles: [] },
      ],
      commandLines: ['node D:\\work\\anki\\node_modules\\vite\\bin\\vite.js'],
    }
    const [finding] = findingsFor(input, 'dirty-worktree')
    expect(finding.level).toBe('drift')
    expect(finding.subject).toBe('D:/work/anki-issue-94')
    expect(finding.message).toMatch(/2 modified tracked file\(s\)/)
    expect(finding.remedy).toMatch(/ask whoever owns it/)
    expect(analyseDrift(input).exitCode).toBe(1)
  })

  it('mentions untracked new files, which is where a brand new file hides', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-issue-94', branch: 'fix/94', dirtyFiles: ['a.ts'], untrackedFiles: ['src/new-thing.ts'] },
      ],
    }
    const [finding] = findingsFor(input, 'dirty-worktree')
    expect(finding.message).toMatch(/1 untracked file\(s\): src\/new-thing\.ts/)
  })

  it('reports untracked files alone as a note rather than stranded work', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-scratch', branch: 'main', dirtyFiles: [], untrackedFiles: ['notes.md'] },
      ],
    }
    const [finding] = findingsFor(input, 'dirty-worktree')
    expect(finding.level).toBe('info')
    expect(analyseDrift(input).exitCode).toBe(0)
  })

  it('flags an untracked file whose normalized text exists on origin/main and prints its restore command', () => {
    const input = {
      ...inStep(),
      cwd: 'D:/work/anki',
      commandLines: [],
      worktrees: [{
        path: 'D:/work/anki-issue-94',
        branch: 'fix/94',
        dirtyFiles: [],
        untrackedFiles: ['docs/guide.md'],
        untrackedRemoteMatches: ['docs/guide.md'],
      }],
    }
    const [finding] = findingsFor(input, 'untracked-remote-duplicate')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/normalized text already on origin\/main: docs\/guide\.md/)
    expect(finding.remedy).toBe('git restore --source=origin/main --staged --worktree -- "docs/guide.md"')
    expect(formatReport(analyseDrift(input))).toContain(finding.remedy)
  })

  it('sets Git to check out detected text files with LF on every platform', () => {
    const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', 'docs/guide.md'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe',
    })
    expect(attributes).toContain('docs/guide.md: text: auto')
    expect(attributes).toContain('docs/guide.md: eol: lf')
  })

  it('does not treat a sibling directory with a shared name prefix as the same worktree', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-94', branch: 'fix/94', dirtyFiles: ['a.ts'], untrackedFiles: [] },
      ],
      commandLines: ['node D:\\work\\anki-94-integrate\\node_modules\\vite\\bin\\vite.js'],
    }
    const [finding] = findingsFor(input, 'dirty-worktree')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/nothing is in it/)
  })
})

describe('branches', () => {
  const withBranch = (branch, pullRequests = []) => ({
    ...inStep(),
    branches: [branch],
    pullRequests,
  })

  it('does not let git trailing newlines turn a merge base into an unreadable revision', () => {
    // `git merge-base` prints a hash and a newline. Passed on untrimmed, the
    // argument becomes `a0667f0\n..branch`, git rejects it, and every branch
    // silently loses its own size. The first real run printed a `fatal:` line
    // per branch above the report, which is how this was found.
    const dirty = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' })
    expect(dirty).toMatch(/\n$/)

    const base = revision(dirty)
    expect(base).toBe(dirty.trim())
    expect(() =>
      execFileSync('git', ['rev-list', '--count', `${dirty}..HEAD`], { encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow()
    const counted = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    expect(Number(counted.trim())).toBeGreaterThanOrEqual(0)
  })

  it('reports commits beyond the merge point of a merged pull request as loss', () => {
    const input = withBranch({ name: 'feat/2-pwa-shell', additions: 1279, deletions: 4 }, [
      { number: 27, state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z', headRefName: 'feat/2-pwa-shell' },
    ])
    const [finding] = findingsFor(input, 'branch-past-merge')
    expect(finding.level).toBe('loss')
    expect(finding.subject).toBe('feat/2-pwa-shell')
    expect(finding.message).toMatch(/#27 merged/)
    expect(analyseDrift(input).exitCode).toBe(2)
  })

  it('reports a branch that differs from main and has no pull request as loss', () => {
    const input = withBranch({ name: 'feat/3-review', additions: 120, deletions: 0 })
    const [finding] = findingsFor(input, 'branch-no-pr')
    expect(finding.level).toBe('loss')
    expect(finding.message).toMatch(/no pull request/)
    expect(analyseDrift(input).exitCode).toBe(2)
  })

  it('reports a closed pull request with no replacement as loss', () => {
    const input = withBranch({ name: 'pr119', additions: 12, deletions: 3 }, [
      { number: 119, state: 'CLOSED', mergedAt: null, headRefName: 'pr119' },
    ])
    const [finding] = findingsFor(input, 'branch-closed-superseded')
    expect(finding.level).toBe('loss')
    expect(finding.message).toMatch(/#119 closed unmerged/)
  })

  it('reports a closed pull request whose content reached main as recoverable', () => {
    const input = withBranch({ name: 'pr119', additions: 0, deletions: 12 }, [
      { number: 119, state: 'CLOSED', mergedAt: null, headRefName: 'pr119' },
    ])
    const [finding] = findingsFor(input, 'branch-closed-superseded')
    expect(finding.level).toBe('drift')
    expect(finding.remedy).toMatch(/git branch -D pr119/)
  })

  it('handles the squash-merge case, where a deletions-only diff means main already has the work', () => {
    const input = withBranch({ name: 'feat/2-pwa-shell', additions: 0, deletions: 4782 }, [
      { number: 27, state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z', headRefName: 'feat/2-pwa-shell' },
    ])
    const report = analyseDrift(input)
    expect(findingsFor(input, 'branch-past-merge')).toEqual([])
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.level).toBe('drift')
    expect(report.exitCode).toBe(1)
  })

  // On 2026-10-06 this check reported six `LOSS` findings and exit code 2, all
  // false: every branch had been re-landed on a differently named branch that
  // merged. The remedy it printed - "open a pull request from the branch" - would
  // have re-landed about 2,400 lines of already-merged code. Byte-identity cannot
  // see this, because main holds the branch's work *plus* later improvements, so
  // the diff has additions as well as deletions.
  describe('work re-landed on another branch', () => {
    it('reads the issue and pull request numbers a branch name carries', () => {
      expect(referencedNumbers('feat/21-offline-storage-protection')).toEqual({ issues: [21], pulls: [] })
      expect(referencedNumbers('fix/85-ios-hint-disclosure')).toEqual({ issues: [85], pulls: [] })
      expect(referencedNumbers('feat/172-export-indexes')).toEqual({ issues: [172], pulls: [] })
      expect(referencedNumbers('review-pr174')).toEqual({ issues: [], pulls: [174] })
      expect(referencedNumbers('pr/113')).toEqual({ issues: [], pulls: [113] })
      // `pr/113` must not also answer as issue 113, or a merged pull request for
      // an unrelated issue 113 would suppress a genuine loss.
      expect(referencedNumbers('review-pr174').issues).not.toContain(174)
      expect(referencedNumbers('main-ish')).toEqual({ issues: [], pulls: [] })
    })

    it('reports an abandoned branch as re-landed when the same issue was re-landed and merged', () => {
      const input = withBranch({ name: 'feat/21-offline-storage-protection', additions: 2003, deletions: 117 }, [
        { number: 135, state: 'CLOSED', mergedAt: null, headRefName: 'feat/21-offline-storage-protection' },
        { number: 198, state: 'MERGED', mergedAt: '2026-10-05T21:39:18Z', headRefName: 'feat/21-offline-storage-rebased' },
      ])
      const [finding] = findingsFor(input, 'branch-relanded')
      expect(finding.level).toBe('drift')
      expect(finding.message).toMatch(/#198 merged/)
      expect(finding.message).toMatch(/feat\/21-offline-storage-rebased/)
      expect(findingsFor(input, 'branch-closed-superseded')).toEqual([])
      expect(analyseDrift(input).exitCode).toBe(1)
    })

    it('recognises a review branch through the pull request it names', () => {
      const input = withBranch({ name: 'review-pr174', additions: 148, deletions: 21 }, [
        { number: 174, state: 'MERGED', mergedAt: '2026-10-04T09:46:06Z', headRefName: 'feat/172-export-indexes' },
      ])
      const [finding] = findingsFor(input, 'branch-relanded')
      expect(finding.level).toBe('drift')
      expect(finding.message).toMatch(/#174 merged/)
      expect(findingsFor(input, 'branch-no-pr')).toEqual([])
      // The level and the exit code are the point of the verdict: a loss sends an
      // agent to open a duplicate pull request, so both are pinned here too.
      expect(analyseDrift(input).exitCode).toBe(1)
    })

    it('never reports a re-landed branch as disposable', () => {
      // A number in a branch name is a convention's fingerprint, not proof the
      // content is identical: two pull requests can work one issue and the second
      // need not contain all of the first. So nothing becomes auto-deletable.
      const pullRequests = [
        { number: 135, state: 'CLOSED', mergedAt: null, headRefName: 'feat/21-offline-storage-protection' },
        { number: 198, state: 'MERGED', mergedAt: '2026-10-05T21:39:18Z', headRefName: 'feat/21-offline-storage-rebased' },
      ]
      const branch = { name: 'feat/21-offline-storage-protection', additions: 2003, deletions: 117 }
      const finding = findingsFor(withBranch(branch, pullRequests), 'branch-relanded')[0]
      expect(
        branchDispositionEvidence(branch, finding, { dirtyFiles: [], untrackedFiles: [] }, pullRequests).disposable,
      ).toBe(false)
    })

    it('still reports loss when the issue was never re-landed', () => {
      const input = withBranch({ name: 'feat/3-review', additions: 120, deletions: 0 }, [
        { number: 41, state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z', headRefName: 'feat/9-unrelated' },
      ])
      expect(findingsFor(input, 'branch-relanded')).toEqual([])
      expect(findingsFor(input, 'branch-no-pr')[0].level).toBe('loss')
      expect(analyseDrift(input).exitCode).toBe(2)
    })

    it('still reports loss when the pull request sharing the number only closed', () => {
      const input = withBranch({ name: 'pr119', additions: 12, deletions: 3 }, [
        { number: 119, state: 'CLOSED', mergedAt: null, headRefName: 'pr119' },
      ])
      expect(findingsFor(input, 'branch-relanded')).toEqual([])
      expect(findingsFor(input, 'branch-closed-superseded')[0].level).toBe('loss')
    })

    it('does not treat a branch as re-landed by its own merged pull request', () => {
      const pullRequests = [
        { number: 27, state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z', headRefName: 'feat/2-pwa-shell' },
      ]
      expect(relandingPullRequest({ name: 'feat/2-pwa-shell' }, pullRequests)).toBeUndefined()
    })

    it('leaves a branch alone when its pull request is still open', () => {
      const input = withBranch({ name: 'feat/2-pwa-shell', additions: 40, deletions: 0 }, [
        { number: 27, state: 'OPEN', mergedAt: null, headRefName: 'feat/2-pwa-shell' },
      ])
      expect(analyseDrift(input).findings).toEqual([])
    })

    it('softens to a note while an agent is in the worktree, as the guide states', () => {
      const branch = { name: 'feat/21-offline-storage-protection', additions: 2003, deletions: 117, worktree: 'D:/work/anki-21' }
      const input = {
        ...withBranch(branch, [
          { number: 198, state: 'MERGED', mergedAt: '2026-10-05T21:39:18Z', headRefName: 'feat/21-offline-storage-rebased' },
        ]),
        // In progress means a worktree whose path a running process names.
        worktrees: [
          { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
          { path: 'D:/work/anki-21', branch: 'feat/21-offline-storage-protection', dirtyFiles: [], untrackedFiles: [] },
        ],
        commandLines: ['node D:/work/anki-21/node_modules/vite/bin/vite.js'],
      }
      const [finding] = findingsFor(input, 'branch-relanded')
      expect(finding.level).toBe('info')
      expect(finding.message).toMatch(/An agent is in it/)
      expect(analyseDrift(input).exitCode).toBe(0)
    })

    it('is documented at the level the check reports it', () => {
      // The guide is what an agent reads to decide what an exit code means, so a
      // renamed verdict or a dropped table row has to fail here rather than be
      // discovered by someone trusting the document.
      const guide = readFileSync(resolve(process.cwd(), 'docs/agents/drift-check.md'), 'utf8')
      expect(guide).toContain('branch-relanded')
      expect(guide).toMatch(/\| 1 \| recoverable drift \|[^\n]*re-landed/)
      expect(guide).toMatch(/reported at level \*\*`drift`\*\*/)
    })
  })

  it('reports commits beyond a merged pull request even when the tree diff only deletes files', () => {
    const input = withBranch({ name: 'feat/2-pwa-shell', additions: 0, deletions: 4782, postMergeCommits: 1 }, [
      { number: 27, state: 'MERGED', mergedAt: '2026-09-30T10:00:00Z', headRefName: 'feat/2-pwa-shell' },
    ])
    const report = analyseDrift(input)
    const [finding] = findingsFor(input, 'branch-past-merge')
    expect(finding.level).toBe('loss')
    expect(finding.message).toMatch(/1 commit\(s\) beyond its pull request head/)
    expect(report.exitCode).toBe(2)
  })

  it('reports a branch byte-identical to main as disposable', () => {
    const input = withBranch({ name: 'backup/18-pre-rebase', additions: 0, deletions: 0 })
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/identical to origin\/main/)
  })

  it('asks git for a branch own size and ancestry, not only its diff against main', () => {
    // Every git invocation goes through gitArgs, so a flag this git rejects is
    // one failing test here rather than a silently empty report.
    expect(gitArgs.diffFromMergeBase('main', 'feat/9-x', 'abc123')).toEqual([
      'diff',
      '--numstat',
      'abc123',
      'feat/9-x',
    ])
    expect(gitArgs.mergeBase('main', 'feat/9-x')).toEqual(['merge-base', 'origin/main', 'feat/9-x'])
    expect(gitArgs.isAncestor('main', 'feat/9-x')).toEqual([
      'merge-base',
      '--is-ancestor',
      'feat/9-x',
      'origin/main',
    ])
    expect(gitArgs.revList('main', 'feat/9-x', 'abc123')).toEqual(['rev-list', '--count', 'abc123..feat/9-x'])
    expect(gitArgs.revListNotIn('main', 'feat/9-x', 'abc123', 'feat/8-y')).toEqual([
      'rev-list',
      'abc123..feat/9-x',
      '--not',
      'feat/8-y',
    ])
    expect(gitArgs.revListNotIn('main', 'feat/9-x', 'abc123', 'feat/8-y', ['--no-merges'])).toEqual([
      'rev-list',
      'abc123..feat/9-x',
      '--not',
      'feat/8-y',
      '--no-merges',
    ])
    expect(gitArgs.revListBeyondPullRequest('abc123', 'feat/9-x')).toEqual([
      'rev-list',
      '--count',
      'abc123..feat/9-x',
      '--no-merges',
    ])
  })

  it('leaves a branch with an open pull request alone', () => {
    const input = withBranch({ name: 'feat/150-oracle', additions: 40, deletions: 2 }, [
      { number: 150, state: 'OPEN', mergedAt: null, headRefName: 'feat/150-oracle' },
    ])
    expect(analyseDrift(input).findings).toEqual([])
  })

  // The three rows below are the branches from issue #158, with the figures the
  // issue records for them. `ownAdditions`/`ownDeletions` are the branch's diff
  // from its merge base; `additions`/`deletions` stay the diff against main.
  it('calls a branch that is an ancestor of main a disposable snapshot, whatever the tree diff says', () => {
    const input = withBranch(
      {
        name: 'audit/85-current-main',
        additions: 1,
        deletions: 1150,
        ownAdditions: 0,
        ownDeletions: 0,
        ownCommits: 0,
        isAncestorOfMain: true,
      },
      [],
    )
    const report = analyseDrift(input)
    expect(findingsFor(input, 'branch-no-pr')).toEqual([])
    expect(findingsFor(input, 'branch-past-merge')).toEqual([])
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/ancestor of origin\/main/)
    expect(finding.message).toMatch(/carries nothing of its own/)
    // A branch that provably holds no work must never claim possible loss.
    expect(report.exitCode).toBe(1)
  })

  it('calls a branch whose work is on an open pull request a merge workspace, not lost work', () => {
    const input = withBranch(
      {
        name: 'merge/99-current-main',
        additions: 2702,
        deletions: 6011,
        ownAdditions: 101,
        ownDeletions: 11,
        ownCommits: 3,
        unsharedBy: { 'feat/106-import-reconciliation': 0 },
        unsharedCommits: 0,
      },
      [{ number: 133, state: 'OPEN', mergedAt: null, headRefName: 'feat/106-import-reconciliation' }],
    )
    const report = analyseDrift(input)
    expect(findingsFor(input, 'branch-no-pr')).toEqual([])
    const [finding] = findingsFor(input, 'branch-merge-workspace')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/#133/)
    expect(finding.message).toMatch(/feat\/106-import-reconciliation/)
    expect(finding.message).toMatch(/carries no unsaved work/)
    expect(finding.remedy).toMatch(/git branch -D merge\/99-current-main/)
    expect(report.exitCode).toBe(1)
  })

  it('still reports a merge workspace as unsaved work when it holds commits on no pull request', () => {
    const input = withBranch(
      {
        name: 'merge/99-current-main',
        additions: 2702,
        deletions: 6011,
        ownAdditions: 101,
        ownDeletions: 11,
        ownCommits: 3,
        unsharedBy: { 'feat/106-import-reconciliation': 1 },
        unsharedCommits: 1,
      },
      [{ number: 133, state: 'OPEN', mergedAt: null, headRefName: 'feat/106-import-reconciliation' }],
    )
    expect(findingsFor(input, 'branch-merge-workspace')).toEqual([])
    const [finding] = findingsFor(input, 'branch-no-pr')
    expect(finding.level).toBe('loss')
    expect(finding.message).toMatch(/101 added line\(s\) and 11 deleted line\(s\) of its own/)
    expect(analyseDrift(input).exitCode).toBe(2)
  })

  it('states a branch own size rather than the size of its diff against main', () => {
    const input = withBranch(
      {
        name: 'feat/160-orphan',
        additions: 5000,
        deletions: 4000,
        ownAdditions: 101,
        ownDeletions: 11,
        ownCommits: 3,
        unsharedCommits: 3,
      },
      [],
    )
    const [finding] = findingsFor(input, 'branch-no-pr')
    expect(finding.message).toMatch(/101 added line\(s\) and 11 deleted line\(s\) of its own/)
    expect(finding.message).not.toMatch(/5000/)
    expect(finding.message).not.toMatch(/4000/)
  })

  it('says which of the two diffs it used, so a reader can tell main-moved-on from branch-has-work', () => {    const input = withBranch(
      {
        name: 'fix/94-review-replay-current',
        additions: 1337,
        deletions: 1315,
        ownAdditions: 1335,
        ownDeletions: 165,
        ownCommits: 17,
        unsharedCommits: 17,
      },
      [],
    )
    const [finding] = findingsFor(input, 'branch-no-pr')
    expect(finding.message).toMatch(/17 commit\(s\) not on origin\/main/)
    expect(finding.message).toMatch(/1335 added line\(s\) and 165 deleted line\(s\) of its own/)
  })

  it('leaves a branch an agent is working in alone', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-issue-118', branch: 'fix/118-mobile-nav-overlap', dirtyFiles: ['src/nav.ts'], untrackedFiles: [] },
      ],
      commandLines: ['node D:/work/anki-issue-118/node_modules/vite/bin/vite.js'],
      branches: [{ name: 'fix/118-mobile-nav-overlap', additions: 0, deletions: 0, worktree: 'D:/work/anki-issue-118' }],
      pullRequests: [],
    }
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.level).toBe('info')
    expect(finding.message).toMatch(/An agent is in it/)
    expect(finding.remedy).toMatch(/none while an agent is in it/)
  })

  it('still reports work on a branch an agent is working in, and never tells them to delete it', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-issue-118', branch: 'fix/118-mobile-nav-overlap', dirtyFiles: [], untrackedFiles: [] },
      ],
      commandLines: ['node D:/work/anki-issue-118/node_modules/vite/bin/vite.js'],
      branches: [{ name: 'fix/118-mobile-nav-overlap', additions: 40, deletions: 1, worktree: 'D:/work/anki-issue-118' }],
      pullRequests: [],
    }
    const [finding] = findingsFor(input, 'branch-no-pr')
    expect(finding.level).toBe('loss')
    expect(finding.remedy).toMatch(/do not delete it/)
    expect(analyseDrift(input).exitCode).toBe(2)
  })

  it('still judges a branch whose worktree nobody is in', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-issue-118', branch: 'fix/118-mobile-nav-overlap', dirtyFiles: [], untrackedFiles: [] },
      ],
      branches: [{ name: 'fix/118-mobile-nav-overlap', additions: 0, deletions: 0, worktree: 'D:/work/anki-issue-118' }],
      pullRequests: [],
    }
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.subject).toBe('fix/118-mobile-nav-overlap')
  })

  it('tells an agent to remove the worktree before the branch, since git refuses the reverse', () => {
    const input = {
      ...inStep(),
      worktrees: [
        { path: 'D:/work/anki', branch: 'main', dirtyFiles: [], untrackedFiles: [] },
        { path: 'D:/work/anki-issue-118', branch: 'fix/118', dirtyFiles: [], untrackedFiles: [] },
      ],
      branches: [{ name: 'fix/118', additions: 0, deletions: 0, worktree: 'D:/work/anki-issue-118' }],
      pullRequests: [],
    }
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.remedy).toMatch(/git worktree remove D:\/work\/anki-issue-118.*git branch -D fix\/118/s)
  })

  it('asks rather than deletes when a branch only differs from main by deletions and has no pull request', () => {
    const input = withBranch({ name: 'wip/86', additions: 0, deletions: 40 })
    const [finding] = findingsFor(input, 'branch-unverified')
    expect(finding.level).toBe('drift')
    expect(finding.remedy).not.toMatch(/git branch -D/)
    expect(finding.message).toMatch(/confirm/)
  })

  it('treats a branch whose only difference is binary as carrying work, not identical', () => {
    const input = withBranch({ name: 'feat/icons', additions: 0, deletions: 0, binary: 2 }, [
      { number: 151, state: 'OPEN', mergedAt: null, headRefName: 'feat/icons' },
    ])
    expect(analyseDrift(input).findings).toEqual([])

    const orphan = withBranch({ name: 'feat/icons', additions: 0, deletions: 0, binary: 2 })
    const [finding] = findingsFor(orphan, 'branch-no-pr')
    expect(finding.level).toBe('loss')
    expect(finding.message).toMatch(/2 binary file\(s\)/)
  })

  it('judges a branch by its live pull request when it has had more than one', () => {
    const input = withBranch({ name: 'feat/19', additions: 40, deletions: 2 }, [
      { number: 19, state: 'CLOSED', mergedAt: null, headRefName: 'feat/19', updatedAt: '2026-09-01T00:00:00Z' },
      { number: 151, state: 'OPEN', mergedAt: null, headRefName: 'feat/19', updatedAt: '2026-10-02T00:00:00Z' },
    ])
    expect(analyseDrift(input).findings).toEqual([])
  })

  it('does not let an open pull request from a different branch hide unmerged work', () => {
    const input = withBranch({ name: 'feat/19-reopened', additions: 40, deletions: 2 }, [
      { number: 151, state: 'OPEN', mergedAt: null, headRefName: 'feat/19', updatedAt: '2026-10-02T00:00:00Z' },
    ])
    const [finding] = findingsFor(input, 'branch-no-pr')
    expect(finding.level).toBe('loss')
  })

  it('does not judge local main itself', () => {
    const input = withBranch({ name: 'main', additions: 3, deletions: 0 })
    expect(analyseDrift(input).findings).toEqual([])
  })
})

describe('what the check could not read', () => {
  it('fails rather than reporting no drift when the tracker is unavailable', () => {
    const input = {
      ...inStep(),
      branches: [{ name: 'feat/3-review', additions: 9, deletions: 0 }],
      pullRequests: null,
    }
    const report = analyseDrift(input)
    const [finding] = findingsFor(input, 'tracker-unavailable')
    expect(finding.level).toBe('drift')
    expect(finding.remedy).toMatch(/gh auth login/)
    expect(report.exitCode).toBe(1)
    expect(formatReport(report)).not.toMatch(/^No drift\./m)
    expect(findingsFor(input, 'branch-no-pr')).toEqual([])
  })

  it('fails rather than reporting no drift when main cannot be read', () => {
    const report = analyseDrift({ ...inStep(), main: null })
    const [finding] = report.findings.filter((f) => f.check === 'main-unknown')
    expect(finding.level).toBe('drift')
    expect(report.exitCode).toBe(1)
  })
})

describe('printing the report', () => {
  it('says so plainly when there is nothing to report', () => {
    expect(formatReport(analyseDrift(inStep()))).toMatch(/^No drift\./)
  })

  it('labels loss and recoverable drift differently, and names what it found', () => {
    const input = {
      ...inStep(),
      main: { branch: 'main', behind: 2, ahead: 0 },
      branches: [{ name: 'feat/3-review', additions: 9, deletions: 0 }],
      pullRequests: [],
    }
    const printed = formatReport(analyseDrift(input))
    expect(printed).toMatch(/^DRIFT {2}main-behind {2}main$/m)
    expect(printed).toMatch(/^LOSS {2}branch-no-pr {2}feat\/3-review$/m)
    expect(printed).toMatch(/fix: git fetch origin && git merge --ff-only origin\/main/)
    expect(printed).toMatch(/1 loss, 1 recoverable, 0 note$/)
  })
})

describe('parsing what the shell reported', () => {
  it('reads worktrees, branches, and detached heads', () => {
    const parsed = parseWorktreePorcelain(
      [
        'worktree D:/work/anki',
        'HEAD a0667f0',
        'branch refs/heads/main',
        '',
        'worktree D:/work/anki-85-baseline',
        'HEAD b947979',
        'branch refs/heads/audit/85-current-main',
        '',
        'worktree D:/work/anki-detached',
        'HEAD 16d7cad',
        'detached',
        '',
      ].join('\n'),
    )
    expect(parsed).toEqual([
      { path: 'D:/work/anki', branch: 'main' },
      { path: 'D:/work/anki-85-baseline', branch: 'audit/85-current-main' },
      { path: 'D:/work/anki-detached', branch: null },
    ])
  })

  it('builds the git arguments this repository version accepts', () => {
    expect(gitArgs.worktreeList()).toEqual(['worktree', 'list', '--porcelain'])
  })

  it('drops the commit a worktree points at, which nothing reads', () => {
    const [first] = parseWorktreePorcelain('worktree D:/work/anki\nHEAD a0667f0\nbranch refs/heads/main\n')
    expect(Object.keys(first).sort()).toEqual(['branch', 'path'])
  })

  it('reads the ahead/behind counts for main', () => {
    expect(parseLeftRightCount('0\t3\n')).toEqual({ behind: 3, ahead: 0 })
    expect(parseLeftRightCount('2\t0\n')).toEqual({ behind: 0, ahead: 2 })
    expect(parseLeftRightCount('')).toEqual(null)
  })

  it('adds up added and deleted lines', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n40\t0\tsrc/b.ts\n')).toEqual({ additions: 52, deletions: 3, binary: 0 })
    expect(parseNumstat('')).toEqual({ additions: 0, deletions: 0, binary: 0 })
  })

  it('counts binary files, which carry work no line count can show', () => {
    expect(parseNumstat('-\t-\tpublic/logo.png\n')).toEqual({ additions: 0, deletions: 0, binary: 1 })
  })

  it('separates edits to tracked files from files git has never seen', () => {
    expect(parseStatus(' M src/a.ts\n?? src/new.ts\nR  src/old.ts -> src/moved.ts\n')).toEqual({
      tracked: ['src/a.ts', 'src/moved.ts'],
      untracked: ['src/new.ts'],
    })
  })
})

describe('reading the command line', () => {
  it('defaults to this repository and main', () => {
    expect(parseArgv([])).toEqual({ help: false, repo: undefined, mainBranch: 'main' })
  })

  it('reads the repository and the main branch when given', () => {
    expect(parseArgv(['--repo', 'butahlecoq/anki', '--main', 'trunk'])).toEqual({
      help: false,
      repo: 'butahlecoq/anki',
      mainBranch: 'trunk',
    })
  })

  it('asks for help rather than reporting anything', () => {
    expect(parseArgv(['--help']).help).toBe(true)
    expect(USAGE).toMatch(/npm run drift|node scripts\/drift-check\.mjs/)
    expect(USAGE).toMatch(/2 {2}possible loss/)
  })
})

describe('which side of main is ahead, according to git', () => {
  const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })

  // The check reads one line of counts from git and has to know which column is
  // which. A hand-written string cannot answer that: `3\t0` is what git prints
  // for `origin/main...main`, and the check reads `main...origin/main`. So the
  // counts come from a throwaway repository, in both directions.
  const scratchRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), 'drift-counts-'))
    git(repo, ['init', '--quiet', '--initial-branch=main'])
    commit(repo, 'first')
    return repo
  }

  const commit = (repo, message) => {
    writeFileSync(join(repo, 'file.txt'), `${message}\n`)
    git(repo, ['add', 'file.txt'])
    git(repo, ['-c', 'user.name=drift', '-c', 'user.email=drift@example.com', 'commit', '--quiet', '-m', message])
  }

  const counts = (repo) => parseLeftRightCount(git(repo, ['rev-list', '--left-right', '--count', 'main...origin/main']))

  it('reads a commit on main that is not on origin/main as ahead, not behind', () => {
    const repo = scratchRepo()
    try {
      git(repo, ['branch', 'origin/main'])
      commit(repo, 'straight to main')
      expect(git(repo, ['rev-list', '--left-right', '--count', 'main...origin/main'])).toMatch(/^1\t0/)
      expect(counts(repo)).toEqual({ behind: 0, ahead: 1 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads a main that is behind origin/main as behind, not ahead', () => {
    const repo = scratchRepo()
    try {
      git(repo, ['checkout', '--quiet', '-b', 'theirs'])
      commit(repo, 'someone else merged first')
      git(repo, ['branch', '-f', 'origin/main', 'theirs'])
      git(repo, ['checkout', '--quiet', 'main'])
      expect(git(repo, ['rev-list', '--left-right', '--count', 'main...origin/main'])).toMatch(/^0\t1/)
      expect(counts(repo)).toEqual({ behind: 1, ahead: 0 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reads a main that has both as both', () => {
    const repo = scratchRepo()
    try {
      git(repo, ['checkout', '--quiet', '-b', 'theirs'])
      commit(repo, 'merged elsewhere')
      git(repo, ['checkout', '--quiet', 'main'])
      commit(repo, 'straight to main')
      git(repo, ['branch', '-f', 'origin/main', 'theirs'])
      expect(counts(repo)).toEqual({ behind: 1, ahead: 1 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('untracked files that duplicate the remote tree', () => {
  const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  const commit = (repo, message) => git(repo, ['-c', 'user.name=drift', '-c', 'user.email=drift@example.com', 'commit', '--quiet', '-m', message])

  it('matches CRLF worktree bytes to LF text on origin/main', () => {
    const repo = mkdtempSync(join(tmpdir(), 'drift-remote-duplicate-'))
    try {
      git(repo, ['init', '--quiet', '--initial-branch=main'])
      git(repo, ['-c', 'user.name=drift', '-c', 'user.email=drift@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'base'])
      git(repo, ['switch', '--quiet', '-c', 'remote-update'])
      writeFileSync(join(repo, 'guide.md'), 'first line\nsecond line\n')
      git(repo, ['add', 'guide.md'])
      commit(repo, 'add remote guide')
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      git(repo, ['switch', '--quiet', 'main'])
      writeFileSync(join(repo, 'guide.md'), 'first line\r\nsecond line\r\n')

      expect(untrackedFilesMatchingRemote({ worktreePath: repo, untrackedFiles: ['guide.md'] })).toEqual(['guide.md'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('matching a process against a worktree path', () => {
  it('matches regardless of case and separator style', () => {
    expect(mentionsPath('node D:\\work\\anki-85-baseline\\vite.js', 'D:/work/anki-85-baseline')).toBe(true)
    expect(mentionsPath('NODE D:/WORK/ANKI-85-BASELINE/vite.js', 'D:\\work\\anki-85-baseline')).toBe(true)
  })

  it('does not match an unrelated directory', () => {
    expect(mentionsPath('node D:\\work\\anki\\vite.js', 'D:/work/anki-85-baseline')).toBe(false)
  })

  it('does not match a longer path that merely starts with the same characters', () => {
    expect(mentionsPath('node D:/work/anki-94-integrate/vite.js', 'D:/work/anki-94')).toBe(false)
  })

  it('ignores empty and non-string input', () => {
    expect(mentionsPath('', 'D:/work/anki')).toBe(false)
    expect(mentionsPath(undefined, 'D:/work/anki')).toBe(false)
  })
})
