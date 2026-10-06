// Reports work that has drifted out of Git and the tracker: branches nobody can find,
// uncommitted work nobody is using, a stale main, and a checkout sitting off main.
// Exits non-zero so it can run unattended. See docs/agents/drift-check.md.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The one place a severity is turned into a label, an exit code and a word for the
// summary, so a finding's level cannot disagree with the code the process returns.
const LEVELS = {
  loss: { label: 'LOSS', prose: 'loss', exitCode: 2 },
  drift: { label: 'DRIFT', prose: 'recoverable', exitCode: 1 },
  info: { label: 'NOTE', prose: 'note', exitCode: 0 },
}

const finding = (level, check, subject, message, remedy) => ({ level, check, subject, message, remedy })

const PLURAL = (count, noun) => `${count} ${noun}(s)`

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // git reports a bad revision on stderr and exits non-zero. Inheriting that
    // stream printed a `fatal:` line per branch above the report, which buried
    // the findings this script exists to print. It is captured and discarded:
    // a null return already says the command failed.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// A revision used as an argument must not carry git's trailing newline, or it
// stops being a revision: `a0667f0\n..branch` is not a range git can read.
export const revision = (output) => (output === null ? null : output.trim() || null)

const normalizedText = (bytes) => {
  if (bytes.includes(0)) return null
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null
  return text.replace(/\r\n?/g, '\n')
}

export function untrackedFilesMatchingRemote({ worktreePath, untrackedFiles, remoteRef = 'origin/main' }) {
  const matches = []
  for (const path of untrackedFiles ?? []) {
    let local
    let remote
    try {
      const localPath = join(worktreePath, path)
      if (!lstatSync(localPath).isFile()) continue
      local = readFileSync(localPath)
      remote = execFileSync('git', ['show', `${remoteRef}:${path}`], {
        cwd: worktreePath,
        windowsHide: true,
        encoding: null,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      continue
    }
    const localText = normalizedText(local)
    const remoteText = normalizedText(remote)
    if (localText !== null && localText === remoteText) matches.push(path)
  }
  return matches
}

function tryRun(command, args, cwd) {
  try {
    return run(command, args, cwd)
  } catch {
    return null
  }
}

// Every git invocation lives here, so a flag this repository's git rejects is a
// single failing test rather than a silently empty report.
export const gitArgs = {
  worktreeList: () => ['worktree', 'list', '--porcelain'],
  aheadBehind: (mainBranch) => ['rev-list', '--left-right', '--count', `${mainBranch}...origin/${mainBranch}`],
  localBranches: () => ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
  diffAgainstMain: (mainBranch, name) => ['diff', '--numstat', `origin/${mainBranch}`, name],
  // Which of a branch's own commits each open pull request does not carry, and
  // whether the branch is already contained in main. The diff against main alone
  // cannot answer either: it also counts every commit main took after the branch
  // point, so a branch holding nothing reads as thousands of lines.
  mergeBase: (mainBranch, name) => ['merge-base', `origin/${mainBranch}`, name],
  diffFromMergeBase: (_mainBranch, name, base) => ['diff', '--numstat', base, name],
  revList: (_mainBranch, name, base) => ['rev-list', '--count', `${base}..${name}`],
  isAncestor: (mainBranch, name) => ['merge-base', '--is-ancestor', name, `origin/${mainBranch}`],
  revListNotIn: (_mainBranch, name, base, head, extra = []) => [
    'rev-list',
    `${base}..${name}`,
    '--not',
    head,
    ...extra,
  ],
  revListBeyondPullRequest: (head, name) => ['rev-list', '--count', `${head}..${name}`, '--no-merges'],
  modifiedTracked: () => ['status', '--porcelain', '--untracked-files=all'],
  remoteUrl: () => ['remote', 'get-url', 'origin'],
}

// `git worktree list --porcelain` is a blank-line separated record per worktree.
export function parseWorktreePorcelain(text) {
  const worktrees = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null }
      continue
    }
    if (!current) continue
    if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length).trim()
    if (line === '') {
      worktrees.push(current)
      current = null
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

// `git rev-list --left-right --count main...origin/main` prints one column per
// side of the `...`, in that order: the first is what `main` has and
// `origin/main` does not, which is ahead, and the second is the reverse, which
// is behind.
export function parseLeftRightCount(text) {
  const match = /^(\d+)\s+(\d+)$/.exec(text.trim())
  return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : null
}

// `git diff --numstat` prints "added<TAB>deleted<TAB>path" per file, and "-" for a
// binary file, which carries work no line count can show.
export function parseNumstat(text) {
  let additions = 0
  let deletions = 0
  let binary = 0
  for (const line of text.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (!match) continue
    if (match[1] === '-' || match[2] === '-') binary += 1
    else {
      additions += Number(match[1])
      deletions += Number(match[2])
    }
  }
  return { additions, deletions, binary }
}

// A process counts as being in a worktree when its command line mentions the path.
// Separator and case differences must not hide it, and a longer sibling path that
// starts with the same characters is a different directory: `anki-94` does not match
// `anki-94-integrate`, because `-` continues a directory name rather than ending one.
export function mentionsPath(commandLine, path) {
  if (typeof commandLine !== 'string' || !commandLine || !path) return false
  const escaped = path.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9._-])${escaped}(?:/|$|[^a-z0-9._-])`, 'i').test(commandLine.replace(/\\/g, '/'))
}

const samePath = (left, right) =>
  typeof left === 'string' && typeof right === 'string' && left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()

// Evidence that somebody is in a worktree, not proof of abandonment: a process whose
// command line mentions the path, or the worktree this check was run from. A session
// that never names its own directory is invisible here, so a "stranded" verdict is a
// prompt to ask, not licence to delete.
function hasEvidenceOfLife(worktree, environment) {
  if (environment.cwd && samePath(environment.cwd, worktree.path)) return true
  return environment.commandLines.some((line) => mentionsPath(line, worktree.path))
}

// `git status --porcelain` prefixes each line with a two-character status code, and
// `??` is the only one that means "not in git at all". Everything else is an edit to
// a file git already tracks, which is the difference between work in progress and a
// new file that would vanish with its directory.
export function parseStatus(output) {
  const tracked = []
  const untracked = []
  for (const line of (output ?? '').split('\n')) {
    if (line.length === 0) continue
    const renamed = / -> (.*)$/.exec(line.slice(3))
    const name = renamed ? renamed[1] : line.slice(3).trim()
    ;(line.startsWith('??') ? untracked : tracked).push(name)
  }
  return { tracked, untracked }
}

function worktreeStatus(path, mainBranch) {
  const output = tryRun('git', gitArgs.modifiedTracked(), path)
  const { tracked, untracked } = parseStatus(output)
  return {
    dirtyFiles: tracked,
    untrackedFiles: untracked,
    untrackedRemoteMatches: untrackedFilesMatchingRemote({ worktreePath: path, untrackedFiles: untracked, remoteRef: `origin/${mainBranch}` }),
  }
}

// `gh` is asked once per run. #158 needs the pull requests inside the collector,
// to decide which branch's work an open pull request already holds, so this is
// returned as a collected fact rather than fetched again by the caller.
export function pullRequestsFor(repo, cwd) {
  const output = tryRun(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '500',
      '--json',
      'number,state,mergedAt,headRefName,headRefOid,updatedAt',
    ],
    cwd,
  )
  if (output === null) return null
  try {
    const parsed = JSON.parse(output)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function branchProvenOnMain(branch, finding) {
  return branch.provenOnMain === true || finding?.provenOnMain === true || (finding?.check === 'branch-stale-snapshot' && (
    branch.isAncestorOfMain === true ||
    (branch.additions === 0 && branch.deletions === 0 && branch.binary === 0)
  ))
}

export function branchDispositionEvidence(branch, finding, tree, pullRequests) {
  const related = pullRequests
    .filter((pr) => pr.headRefName === branch.name && ['MERGED', 'CLOSED'].includes(pr.state))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))[0]
  const clean = Boolean(tree) && !(tree.dirtyFiles?.length || tree.untrackedFiles?.length)
  return {
    disposable: Boolean(related && clean && branchProvenOnMain(branch, finding)),
    relatedPrNumber: related?.number,
  }
}

// The state that decides a branch's fate, so `gh`'s listing order cannot.
const STATE_RANK = { OPEN: 0, MERGED: 1, CLOSED: 2 }

/**
 * The numbers a branch name carries: the issue it works, or the pull request it
 * reviews. `feat/21-offline-storage-protection` is issue 21;
 * `review-pr174` and `pr/113` name a pull request.
 */
export function referencedNumbers(name) {
  const pullReference = /(?:^|[/-])(?:pr|pull)[/-]?(\d+)\b/gi
  const pulls = [...name.matchAll(pullReference)].map((match) => Number(match[1]))
  // A branch named `pr/113` points at pull request 113, not at issue 113. Mask
  // the reference before scanning for issues so it cannot also answer as one:
  // reading it both ways would let a merged pull request for an unrelated issue
  // 113 suppress a genuine loss.
  const withoutPulls = pulls.length
    ? name.replace(new RegExp(pullReference.source, 'gi'), (match) => match.replace(/\d+/, ''))
    : name
  const issues = [...withoutPulls.matchAll(/(?:^|[/-])(\d+)(?:-|$)/g)].map((match) => Number(match[1]))
  return { issues, pulls }
}

/**
 * The merged pull request that carried this branch's work on a differently
 * named branch, when there is one.
 *
 * This repository re-lands issue work on a fresh branch named after the issue -
 * `feat/19-interruption-safe-sync` became `feat/19-interruption-safe-sync-current`
 * and then `feat/19-resumable-fault-recovery` - and abandons the original. The
 * abandoned branch then reads as a loss, because byte-identity and ancestry both
 * fail: `main` holds its work *plus* later improvements, so the diff has
 * additions as well as deletions and the squash-merge rule cannot fire either.
 *
 * Matching on the number a branch name carries is the convention's fingerprint.
 * It is deliberately not treated as proof that the content is identical - the
 * caller reports a question, never a deletion - because two pull requests can
 * work one issue and the second need not contain all of the first.
 */
export function relandingPullRequest(branch, pullRequests) {
  if (!pullRequests) return undefined
  const { issues, pulls } = referencedNumbers(branch.name)
  const wanted = new Set([...issues, ...pulls])
  if (wanted.size === 0) return undefined
  return pullRequests
    .filter((pr) => {
      if (pr.state !== 'MERGED' || pr.headRefName === branch.name) return false
      // A branch named after the pull request it reviews points at that pull
      // request directly; a branch named after an issue points at whichever pull
      // request re-landed that issue.
      if (pulls.includes(pr.number)) return true
      return [...pr.headRefName.matchAll(/(?:^|[/-])(\d+)(?:-|$)/g)].some((match) => issues.includes(Number(match[1])))
    })
    .sort((left, right) => (right.mergedAt ?? '').localeCompare(left.mergedAt ?? ''))[0]
}

export function livePullRequestPerBranch(pullRequests) {
  const chosen = new Map()
  for (const pr of pullRequests) {
    const held = chosen.get(pr.headRefName)
    const better =
      held === undefined ||
      STATE_RANK[pr.state] < STATE_RANK[held.state] ||
      (STATE_RANK[pr.state] === STATE_RANK[held.state] && (pr.updatedAt ?? '') > (held.updatedAt ?? ''))
    if (better) chosen.set(pr.headRefName, pr)
  }
  return chosen
}

const windowsCommandLines = () => {
  const output = tryRun('powershell', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  ])
  if (output === null) return []
  try {
    const parsed = JSON.parse(output)
    const processes = Array.isArray(parsed) ? parsed : [parsed]
    return processes.filter((entry) => entry && entry.ProcessId !== process.pid).map((entry) => entry.CommandLine).filter(Boolean)
  } catch {
    return []
  }
}

const posixCommandLines = () =>
  (tryRun('ps', ['-eo', 'pid=,args=']) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(`${process.pid} `))
    .map((line) => line.replace(/^\d+\s+/, ''))

export const runningCommandLines = () => (process.platform === 'win32' ? windowsCommandLines() : posixCommandLines())

export function collectGitFacts({ cwd = process.cwd(), mainBranch = 'main', repo = 'butahlecoq/anki' } = {}) {
  const porcelain = tryRun('git', gitArgs.worktreeList(), cwd)
  const worktrees = porcelain === null ? [] : parseWorktreePorcelain(porcelain)
  const present = worktrees.filter((worktree) => existsSync(worktree.path))
  const counts = parseLeftRightCount(tryRun('git', gitArgs.aheadBehind(mainBranch), cwd) ?? '')

  const names = (tryRun('git', gitArgs.localBranches(), cwd) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== mainBranch)

  // Which open pull request heads are already contained in each branch, and how
  // many of its commits no open pull request can account for. Both need the pull
  // requests, so they are collected here and handed to the pure analysis.
  const pullRequests = pullRequestsFor(repo, cwd)
  const openHeads = (pullRequests ?? []).filter((pr) => pr.state === 'OPEN').map((pr) => pr.headRefName)

  const branches = names.map((name) => {
    const worktree = present.find((entry) => entry.branch === name)?.path ?? null
    const base = revision(tryRun('git', gitArgs.mergeBase(mainBranch, name), cwd))
    const own =
      base === null
        ? null
        : {
            ...parseNumstat(tryRun('git', gitArgs.diffFromMergeBase(mainBranch, name, base), cwd) ?? ''),
            ownCommits: Number(revision(tryRun('git', gitArgs.revList(mainBranch, name, base), cwd)) ?? NaN),
          }
    const unsharedBy = countUnsharedByOpenHead({ base, name, openHeads, cwd, mainBranch })
    const branchPr = livePullRequestPerBranch(pullRequests ?? []).get(name)
    const postMergeCommits = branchPr?.state === 'MERGED' && branchPr.headRefOid
      ? Number(revision(tryRun('git', gitArgs.revListBeyondPullRequest(branchPr.headRefOid, name, cwd)) ?? '') ?? NaN)
      : undefined
    return {
      name,
      ...parseNumstat(tryRun('git', gitArgs.diffAgainstMain(mainBranch, name), cwd) ?? ''),
      ...(own ?? {}),
      // `--is-ancestor` exits 0 and prints nothing, so exit status is the answer.
      isAncestorOfMain: tryRun('git', gitArgs.isAncestor(mainBranch, name), cwd) !== null,
      unsharedBy,
      unsharedCommits: unsharedBy === undefined ? undefined : Math.min(...Object.values(unsharedBy)),
      postMergeCommits,
      worktree,
    }
  })

  return {
    main: counts === null ? null : { branch: mainBranch, ...counts },
    primary: present[0] ?? null,
    worktrees: present.map((worktree) => ({ ...worktree, ...worktreeStatus(worktree.path, mainBranch) })),
    branches,
    pullRequests,
  }
}

// For each open pull request head, how many of this branch's own commits that
// head does not carry. `git rev-list <base>..<branch> --not <head>` is that
// count directly: a branch whose commits are all on an open pull request
// returns nothing.
//
// A merge commit is not lost work. `fix/94-review-replay-current` is #117's
// branch with main merged into it, so the merge commit itself is in no pull
// request and the raw count is 1. Counting only commits that introduced a
// change on this branch gives 0, which is the honest answer.
function countUnsharedByOpenHead({ base, name, openHeads, cwd, mainBranch }) {
  if (base === null || openHeads.length === 0) return undefined
  const unsharedBy = {}
  for (const head of openHeads) {
    if (head === name) continue
    const listed = tryRun('git', gitArgs.revListNotIn(mainBranch, name, base, head), cwd)
    if (listed === null) continue
    const commits = listed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    // `--no-merges` is the second question git is asked, so a merge that exists
    // only to bring main in is not counted as work nobody has.
    const withoutMerges = tryRun('git', gitArgs.revListNotIn(mainBranch, name, base, head, ['--no-merges']), cwd)
    unsharedBy[head] =
      withoutMerges === null
        ? commits.length
        : withoutMerges.split('\n').filter((line) => line.trim().length > 0).length
  }
  return Object.keys(unsharedBy).length === 0 ? undefined : unsharedBy
}

// git refuses to delete a branch that a worktree has checked out, so the worktree
// goes first.
const removal = (branch) =>
  branch.worktree === null
    ? `git branch -D ${branch.name}`
    : `git worktree remove ${branch.worktree} (from outside it), then git branch -D ${branch.name}`

// The size of the work a branch itself carries, as opposed to the size of its
// diff against main, which also counts every commit main took after the branch
// point. `ownSize` is absent when the merge base could not be read, and the
// caller then falls back to the main diff rather than claiming a number.
const ownSizeOf = (branch, mainBranch) =>
  branch.ownAdditions === undefined
    ? `${PLURAL(branch.additions, 'added line')} and ${PLURAL(branch.deletions, 'deleted line')} against origin/${mainBranch}`
    : `${PLURAL(branch.ownAdditions, 'added line')} and ${PLURAL(branch.ownDeletions, 'deleted line')} of its own, across ${PLURAL(branch.ownCommits ?? 0, 'commit')} not on origin/${mainBranch}`

// Which open pull request, if any, already holds the work on this branch. A
// branch with `main` merged into it points at no pull request of its own, so
// this is asked of the pull requests rather than of the branch name.
//
// The collector reports, per open pull request, how many of this branch's own
// commits that pull request does not carry. The two merge workspaces on this
// machine relate to their pull requests in opposite directions - #133's head
// contains `merge/99-current-main`, while `fix/94-review-replay-current`
// contains #117's head - so containment in either direction is not the test.
// "Commits of this branch that no open pull request carries" is.
function openPullRequestHolding(branch, pullRequests) {
  const unshared = branch.unsharedBy ?? {}
  const holding = pullRequests.find((pr) => pr.state === 'OPEN' && unshared[pr.headRefName] === 0)
  if (holding === undefined) return undefined
  return { ...holding, unshared: 0 }
}

function branchFindings({ branches, pullRequests, mainBranch, inProgress }) {
  const findings = []
  const byHead = livePullRequestPerBranch(pullRequests)

  for (const branch of branches) {
    if (branch.name === mainBranch) continue
    const pr = byHead.get(branch.name)
    if (pr?.state === 'OPEN') continue

    const subject = branch.name
    const busy = inProgress.has(branch.name)
    const where = branch.worktree === null ? 'no worktree' : `worktree ${branch.worktree}`
    const handOn = busy ? ' An agent is in it, so do not delete it.' : ''
    const remedy = busy
      ? `ask the agent working in ${branch.worktree ?? 'it'} what happens next - do not delete it; opening a pull request is usually the answer`
      : removal(branch)
    const carriesWork = branch.additions > 0 || branch.binary > 0
    const size = `${PLURAL(branch.additions, 'added line')} and ${PLURAL(branch.deletions, 'deleted line')} against origin/${mainBranch}`
    const binaryNote = branch.binary > 0 ? `, including ${PLURAL(branch.binary, 'binary file')}` : ''

    // A strict ancestor of main holds no commit that main does not, so whatever
    // its tree diff says it cannot carry unsaved work. This has to be decided
    // before the diff is read: an ancestor that main has since edited reports a
    // one-line diff in one direction, which used to read as possible loss.
    if (branch.isAncestorOfMain === true) {
      findings.push(
        finding(
          busy ? 'info' : 'drift',
          pr?.state === 'CLOSED' ? 'branch-closed-superseded' : 'branch-stale-snapshot',
          subject,
          `it is an ancestor of origin/${mainBranch} and carries nothing of its own, so it is a stale snapshot whatever it diffs by (${where}).${handOn}`,
          busy ? 'none while an agent is in it' : remedy,
        ),
      )
      continue
    }

    // A branch that has main merged into it holds work an open pull request
    // already carries. It is a workspace for a merge that was started and not
    // finished, not work at risk.
    const holding = openPullRequestHolding(branch, pullRequests)
    if (holding !== undefined && (branch.unsharedCommits ?? 0) === 0) {
      findings.push(
        finding(
          busy ? 'info' : 'drift',
          'branch-merge-workspace',
          subject,
          `its work is on pull request #${holding.number} (${holding.headRefName}), so it carries no unsaved work: it is a workspace for a merge that was started and not finished (${where}).${handOn}`,
          busy ? 'none while an agent is in it' : remedy,
        ),
      )
      continue
    }

    if (pr?.state === 'MERGED' && (branch.postMergeCommits ?? 0) > 0) {
      findings.push(
        finding(
          'loss',
          'branch-past-merge',
          subject,
          `pull request #${pr.number} merged on ${pr.mergedAt?.slice(0, 10)}, but the branch has ${PLURAL(branch.postMergeCommits, 'commit')} beyond its pull request head (${where}).${handOn}`,
          busy ? remedy : 'rebase the branch onto origin/main and open a pull request, or confirm the work already reached main',
        ),
      )
      continue
    }

    // A branch can only be recommended for deletion when main is known to hold the
    // work, or when it is byte-identical. Anything else asks a question.
    if (!carriesWork && branch.deletions === 0) {
      findings.push(
        finding(
          busy ? 'info' : 'drift',
          pr?.state === 'CLOSED' ? 'branch-closed-superseded' : 'branch-stale-snapshot',
          subject,
          `${describePr(pr) ?? 'No pull request has ever pointed at it'}; the branch is identical to origin/${mainBranch} (${where}).${handOn}`,
          busy ? 'none while an agent is in it' : remedy,
        ),
      )
      continue
    }

    if (!carriesWork && pr?.state === 'MERGED') {
      // Ancestry checks are useless after a squash merge, so `main` having the
      // content is what makes a merged branch disposable rather than lost.
      findings.push(
        finding(
          busy ? 'info' : 'drift',
          'branch-stale-snapshot',
          subject,
          `${describePr(pr)}, and its content is on origin/${mainBranch}: the branch differs only by ${PLURAL(branch.deletions, 'deleted line')} (${where}).${handOn}`,
          busy ? 'none while an agent is in it' : remedy,
        ),
      )
      continue
    }

    if (!carriesWork && pr?.state === 'CLOSED') {
      findings.push(
        finding(
          busy ? 'info' : 'drift',
          'branch-closed-superseded',
          subject,
          `${describePr(pr)}; its content is on origin/${mainBranch}, so the branch is a stale snapshot (${where}).${handOn}`,
          busy ? 'none while an agent is in it' : remedy,
        ),
      )
      continue
    }

    if (!carriesWork) {
      // Deletions-only, and nothing in the tracker to say what they mean: this may
      // be a snapshot taken before main advanced, or it may be unmerged deletion
      // work. Recommend neither.
      findings.push(
        finding(
          'drift',
          'branch-unverified',
          subject,
          `No pull request points at it, and it differs from origin/${mainBranch} only by ${PLURAL(branch.deletions, 'deleted line')} (${where}). That is either a stale snapshot or unmerged deletion work; confirm which before removing it.${handOn}`,
          busy ? remedy : `git diff --stat origin/${mainBranch} ${subject}, then either remove it or open a pull request from it`,
        ),
      )
      continue
    }

    if (pr?.state === 'MERGED') {
      findings.push(
        finding(
          'loss',
          'branch-past-merge',
          subject,
          `pull request #${pr.number} merged on ${pr.mergedAt?.slice(0, 10)}, but the branch still carries ${ownSizeOf(branch, mainBranch)}${binaryNote} (${where}).${handOn}`,
          busy ? remedy : 'rebase the branch onto origin/main and open a pull request, or confirm the work already reached main',
        ),
      )
      continue
    }

    // The issue this branch works may have been re-landed on another branch that
    // merged. Reported as a question rather than a loss: the remedy for a loss
    // says "open a pull request from the branch", and following that against
    // already-merged work duplicates it. Nothing here becomes disposable, so the
    // branch is still retained until a person compares the two.
    const relanded = relandingPullRequest(branch, pullRequests)
    if (relanded !== undefined) {
      const relandedHead = relanded.headRefName
      const relandedAt = relanded.mergedAt?.slice(0, 10)
      findings.push(
        finding(
          busy ? 'info' : 'drift',
          'branch-relanded',
          subject,
          `pull request #${relanded.number} merged on ${relandedAt} from \`${relandedHead}\`, a differently named branch for the same issue. That is where this issue's work is believed to have been re-landed - main holds it plus later work, so it cannot be shown byte-identical either. Same issue is not the same content, so confirm what this branch still holds that pull request #${relanded.number} does not, then remove it (${where}).${handOn}`,
          busy
            ? remedy
            : `git diff --stat origin/${mainBranch} ${subject} - if the branch adds nothing pull request #${relanded.number} does not, remove it with the worktree first; otherwise reopen the work`,
        ),
      )
      continue
    }

    if (pr?.state === 'CLOSED') {
      findings.push(
        finding(
          'loss',
          'branch-closed-superseded',
          subject,
          `pull request #${pr.number} closed unmerged with no replacement, and the branch still carries ${ownSizeOf(branch, mainBranch)}${binaryNote} (${where}).${handOn}`,
          busy ? remedy : `reopen the work on a fresh branch from origin/${mainBranch}, or confirm it was abandoned`,
        ),
      )
      continue
    }

    findings.push(
      finding(
        'loss',
        'branch-no-pr',
        subject,
        `branch has no pull request at all and still carries ${ownSizeOf(branch, mainBranch)}${binaryNote} (${where}).${handOn}`,
        busy ? remedy : 'open a pull request from the branch, or move the work somewhere the tracker can see it',
      ),
    )
  }

  return findings
}

const describePr = (pr) =>
  pr === undefined
    ? undefined
    : pr.state === 'MERGED'
      ? `Pull request #${pr.number} merged on ${pr.mergedAt?.slice(0, 10)}`
      : `Pull request #${pr.number} closed unmerged`

function mainFindings({ main }) {
  if (main === null) {
    return [
      finding(
        'drift',
        'main-unknown',
        'main',
        'local main or origin/main could not be read, so nothing about main was checked',
        'git fetch origin, then run this again',
      ),
    ]
  }
  const findings = []
  if (main.behind > 0) {
    findings.push(
      finding('drift', 'main-behind', 'main', `main is ${PLURAL(main.behind, 'commit')} behind origin/main`, 'git fetch origin && git merge --ff-only origin/main'),
    )
  }
  if (main.ahead > 0) {
    findings.push(
      finding(
        'drift',
        'main-ahead',
        'main',
        `main has ${PLURAL(main.ahead, 'commit')} not on origin/main, so that work exists only here`,
        'open a pull request from a branch, and never commit straight to main',
      ),
    )
  }
  return findings
}

function worktreeFindings({ worktrees, environment }) {
  return worktrees.flatMap((worktree) => {
    const tracked = worktree.dirtyFiles ?? []
    const untracked = worktree.untrackedFiles ?? []
    const remoteMatches = worktree.untrackedRemoteMatches ?? []
    const duplicateFinding = remoteMatches.length === 0 ? [] : [
      finding(
        samePath(environment.cwd, worktree.path) || environment.commandLines.some((line) => mentionsPath(line, worktree.path)) ? 'info' : 'drift',
        'untracked-remote-duplicate',
        worktree.path,
        `${PLURAL(remoteMatches.length, 'untracked file')} match normalized text already on origin/main: ${remoteMatches.join(', ')}`,
        remoteMatches.map((path) => `git restore --source=origin/main --staged --worktree -- "${path}"`).join(' && '),
      ),
    ]
    if (tracked.length === 0 && untracked.length === 0) return []

    const untrackedNote = untracked.length === 0 ? '' : `, ${PLURAL(untracked.length, 'untracked file')}: ${untracked.join(', ')}`
    const live = hasEvidenceOfLife(worktree, environment)

    // Untracked files alone are ordinary: a scratch note is not lost work. Tracked
    // modifications are, because they are edits to files that already exist.
    if (tracked.length === 0) {
      return [...duplicateFinding,
        finding(
          'info',
          'dirty-worktree',
          worktree.path,
          `${PLURAL(untracked.length, 'untracked file')} and no tracked file changed: ${untracked.join(', ')}`,
          'commit them if they are work; leave them if they are scratch',
        ),
      ]
    }

    return [...duplicateFinding,
      finding(
        live ? 'info' : 'drift',
        'dirty-worktree',
        worktree.path,
        `${PLURAL(tracked.length, 'modified tracked file')}: ${tracked.join(', ')}${untrackedNote} — ${live ? 'something is in it, so this is work in progress' : 'nothing is in it'}`,
        live
          ? 'none; leave it alone'
          : 'ask whoever owns it before touching it; otherwise commit and open a pull request, or move the work before deleting the worktree',
      ),
    ]
  })
}

export function analyseDrift(input) {
  const { main, primary, worktrees = [], branches = [], pullRequests, commandLines = [], cwd } = input
  const environment = { commandLines, cwd }
  const live = new Set(worktrees.filter((worktree) => hasEvidenceOfLife(worktree, environment)).map((worktree) => worktree.path))
  const inProgress = new Set(worktrees.filter((worktree) => live.has(worktree.path)).map((worktree) => worktree.branch).filter(Boolean))

  const findings = [...mainFindings({ main })]
  if (primary && primary.branch !== main?.branch) {
    findings.push(
      finding(
        'drift',
        'primary-not-main',
        primary.path,
        `the primary working directory is on ${primary.branch ?? 'a detached HEAD'}, not on ${main?.branch ?? 'main'}, so running the product from it uses untested code`,
        `git switch ${main?.branch ?? 'main'} in ${primary.path}`,
      ),
    )
  }
  findings.push(...worktreeFindings({ worktrees, environment }))

  if (pullRequests === null) {
    // Failing open here would print "No drift" for a check that judged nothing.
    findings.push(
      finding(
        'drift',
        'tracker-unavailable',
        'pull requests',
        'the tracker could not be read, so no branch was judged against its pull request',
        'gh auth login, then run this again',
      ),
    )
  } else {
    findings.push(...branchFindings({ branches, pullRequests, mainBranch: main?.branch ?? 'main', inProgress }))
  }

  const exitCode = findings.reduce((worst, item) => Math.max(worst, LEVELS[item.level].exitCode), 0)
  return { findings, exitCode }
}

export function formatReport(report) {
  if (report.findings.length === 0) return 'No drift. Local main matches origin/main, every branch has a live pull request, and every worktree is clean.'
  const lines = []
  for (const item of report.findings) {
    lines.push(`${LEVELS[item.level].label}  ${item.check}  ${item.subject}`)
    lines.push(`      ${item.message}`)
    lines.push(`      fix: ${item.remedy}`)
    lines.push('')
  }
  const count = (level) => report.findings.filter((item) => item.level === level).length
  const summary = Object.entries(LEVELS).map(([level, meta]) => `${count(level)} ${meta.prose}`)
  lines.push(summary.join(', '))
  return lines.join('\n')
}

export const USAGE = `Usage: node scripts/drift-check.mjs [--repo <owner/name>] [--main <branch>]

Reports work stranded outside Git and the tracker, and exits non-zero when it finds any:
  0  no drift
  1  recoverable drift: stale main, uncommitted work nothing is in, a disposable branch,
     a branch an ancestor of main, a merge workspace for an open pull request, or
     something this check could not read
  2  possible loss: a branch with work that is on no pull request, or past a merge`

export function parseArgv(argv) {
  const valueOf = (flag) => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  return { help: argv.includes('--help'), repo: valueOf('--repo'), mainBranch: valueOf('--main') ?? 'main' }
}

export function repoFromRemote(cwd, fallback) {
  const remote = tryRun('git', gitArgs.remoteUrl(), cwd)
  const fromRemote = remote?.trim().match(/github\.com[/:]([^/]+\/[^/\s]+?)(?:\.git)?$/)?.[1]
  return fromRemote ?? fallback
}

function main(argv) {
  const { help, repo: requested, mainBranch } = parseArgv(argv)
  if (help) {
    console.log(USAGE)
    return 0
  }

  const cwd = process.cwd()
  const repo = requested ?? repoFromRemote(cwd, 'butahlecoq/anki')
  const facts = collectGitFacts({ cwd, mainBranch, repo })
  const report = analyseDrift({
    ...facts,
    // Already collected above; #158 needs them there, and asking `gh` twice would
    // read the tracker twice and could disagree with itself.
    pullRequests: facts.pullRequests,
    commandLines: runningCommandLines(),
    cwd,
  })

  console.log(`Drift check for ${repo} (${cwd})`)
  console.log('')
  console.log(formatReport(report))
  return report.exitCode
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
