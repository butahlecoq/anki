// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  analyseDrift,
  formatReport,
  gitArgs,
  mentionsPath,
  parseArgv,
  parseLeftRightCount,
  parseNumstat,
  parseStatus,
  parseWorktreePorcelain,
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
    expect(analyseDrift(input).exitCode).toBe(1)
  })

  it('reports unpushed commits sitting on main', () => {
    const input = { ...inStep(), main: { branch: 'main', behind: 0, ahead: 1 } }
    const [finding] = findingsFor(input, 'main-ahead')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/1 commit\(s\) not on origin\/main/)
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

  it('reports a branch byte-identical to main as disposable', () => {
    const input = withBranch({ name: 'backup/18-pre-rebase', additions: 0, deletions: 0 })
    const [finding] = findingsFor(input, 'branch-stale-snapshot')
    expect(finding.level).toBe('drift')
    expect(finding.message).toMatch(/identical to origin\/main/)
  })

  it('leaves a branch with an open pull request alone', () => {
    const input = withBranch({ name: 'feat/150-oracle', additions: 40, deletions: 2 }, [
      { number: 150, state: 'OPEN', mergedAt: null, headRefName: 'feat/150-oracle' },
    ])
    expect(analyseDrift(input).findings).toEqual([])
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
    expect(parseLeftRightCount('3\t0\n')).toEqual({ behind: 3, ahead: 0 })
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