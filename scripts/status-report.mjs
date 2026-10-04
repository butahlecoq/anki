// Regenerates docs/agents/status.md from current Git and GitHub state.
// This is a snapshot of the machine that runs it; it is never committed by the tool.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { analyseDrift, collectGitFacts, runningCommandLines } from './drift-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = 'butahlecoq/anki'

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function ghJson(args) {
  return JSON.parse(run('gh', args))
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

function issueNumber(text) {
  return /(?:^|[\s(/])#(\d+)\b/.exec(text ?? '')?.[1] ?? null
}

function linkedIssue(pr) {
  const explicit = /(?:closes?|fixes?|refs?|progress on)\s+#(\d+)/i.exec(pr.body ?? '')?.[1]
  const title = issueNumber(pr.title)
  const branch = /(?:^|[/-])(\d+)(?:-|$)/.exec(pr.headRefName ?? '')?.[1]
  return Number(explicit ?? title ?? branch ?? NaN)
}

export function deferredLines(pr, comments = []) {
  const markers = /\b(?:remains? open|does not close|doesn't close|not yet|still required|blocked|pending (?:review|verification|acceptance|evidence|decision|device|human|full gate))\b|\b(?:is|are|was|were|remains?|remain) deferred\b/i
  const prLines = (pr.body ?? '').split('\n')
  const extractSections = (lines) => {
    const selected = []
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^#{1,4}\s+(?:deferred?|remaining|outstanding)\b/i.test(lines[index].trim())) continue
      for (let next = index + 1; next < lines.length && !/^#{1,4}\s/.test(lines[next].trim()); next += 1) {
        const trimmed = lines[next].trim()
        if (trimmed && !/^Issue #\d+ remains open\b/i.test(trimmed)) selected.push(trimmed)
      }
    }
    return selected
  }
  const prSections = extractSections(prLines)
  const inlineDeferrals = prLines.filter((line) => !/^#{1,4}\s/.test(line.trim()) && markers.test(line))
  const fromPr = [...prSections, ...inlineDeferrals]
    .map((line) => line.trim()).filter(Boolean)
  const fromComments = []
  for (const comment of [...comments].reverse()) {
    const lines = (comment.body ?? '').split('\n')
    fromComments.push(...extractSections(lines))
  }
  return [...new Set([...fromPr, ...fromComments])]
}

export function checkState(pr, checkSnapshot) {
  if (!checkSnapshot || checkSnapshot.oid !== pr.headRefOid) return 'could not verify exact PR head'
  if (!checkSnapshot.state || checkSnapshot.state === 'EXPECTED') return 'no hosted checks reported'
  if (checkSnapshot.state === 'FAILURE' || checkSnapshot.state === 'ERROR') return 'failing'
  if (checkSnapshot.state === 'PENDING') return 'pending'
  if (checkSnapshot.state === 'SUCCESS') return 'passed on exact head'
  return `unknown check state (${checkSnapshot.state})`
}

export function branchDisposition(branch, finding, tree, pullRequests) {
  const related = pullRequests
    .filter((pr) => pr.headRefName === branch.name && ['MERGED', 'CLOSED'].includes(pr.state))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))[0]
  const clean = !tree || (!tree.dirtyFiles.length && !tree.untrackedFiles.length)
  const alreadyOnMain = ['branch-stale-snapshot', 'branch-closed-superseded'].includes(finding?.check)
  const disposable = Boolean(related && clean && alreadyOnMain)
  return {
    disposition: disposable ? 'provably disposable' : 'retain',
    relatedPrNumber: related?.number,
  }
}

export function omitGeneratedStatusFile(worktrees, repositoryRoot = root) {
  const normalizedRoot = repositoryRoot.replaceAll('\\', '/').toLowerCase()
  const reportPath = 'docs/agents/status.md'
  return worktrees.map((tree) => tree.path.replaceAll('\\', '/').toLowerCase() === normalizedRoot
    ? { ...tree, dirtyFiles: tree.dirtyFiles.filter((file) => file.replaceAll('\\', '/').toLowerCase() !== reportPath), untrackedFiles: tree.untrackedFiles.filter((file) => file.replaceAll('\\', '/').toLowerCase() !== reportPath) }
    : tree)
}

function statusForIssue(issue, prs, worktrees, commentsByIssue, checksByPr) {
  const issuePrs = prs.filter((pr) => linkedIssue(pr) === issue.number)
  const issueWorktrees = worktrees.filter((tree) => new RegExp(`(?:^|[/-])${issue.number}(?:-|$)`).test(tree.branch ?? ''))
  if (!issuePrs.length && !issueWorktrees.length) return null
  const rows = []
  for (const pr of issuePrs) {
    const tree = issueWorktrees.find((item) => item.branch === pr.headRefName)
    const deferred = deferredLines(pr, commentsByIssue.get(issue.number) ?? [])
    rows.push(`PR [#${pr.number}](${pr.url}) (${pr.isDraft ? 'draft' : 'open'}); head \`${pr.headRefOid}\`; exact-head checks: ${checkState(pr, checksByPr.get(pr.number))}; branch \`${pr.headRefName}\`; worktree: ${tree?.path ?? 'not registered'}; deferred: ${deferred.length ? deferred.map(escapeCell).join('; ') : 'none stated in PR or checkpoint comments'}`)
  }
  for (const tree of issueWorktrees.filter((item) => !issuePrs.some((pr) => pr.headRefName === item.branch))) {
    const deferred = deferredLines({}, commentsByIssue.get(issue.number) ?? [])
    rows.push(`No open PR; exact-head checks: not applicable; branch \`${tree.branch}\`; worktree: ${tree.path}; local commits ahead of origin/main: ${tree.ahead ?? 'unknown'}; deferred: ${deferred.length ? deferred.map(escapeCell).join('; ') : 'none stated in checkpoint comments'}`)
  }
  return { issue, rows }
}

export function renderStatus({ issues, prs, worktrees, branches, commentsByIssue = new Map(), checksByPr = new Map(), generatedFrom }) {
  const inFlight = issues.map((issue) => statusForIssue(issue, prs, worktrees, commentsByIssue, checksByPr)).filter(Boolean)
  const dirty = worktrees.filter((tree) => tree.dirtyFiles?.length || tree.untrackedFiles?.length)
  const superseded = branches.filter((branch) => branch.disposition === 'provably disposable')
  const lines = [
    '# Live repository status',
    '',
    '> Generated by `npm run status`. Machine-local Git state and GitHub state at generation time; do not edit by hand.',
    '',
    `Base commit: \`${generatedFrom}\` (current \`origin/main\`).`,
    '',
    '## In-flight issues',
    '',
  ]
  if (!inFlight.length) lines.push('No open issue currently has a matching open PR or registered issue branch.')
  for (const { issue, rows } of inFlight) {
    lines.push(`### [#${issue.number} ${issue.title}](${issue.url})`, '', ...rows.map((row) => `- ${row}`), '')
  }
  lines.push('## Dirty worktrees', '')
  if (!dirty.length) lines.push('All registered worktrees are clean.')
  else for (const tree of dirty) lines.push(`- \`${tree.path}\` (${tree.branch ?? 'detached'}): ${[...(tree.dirtyFiles ?? []), ...(tree.untrackedFiles ?? [])].join(', ')}`)
  lines.push('', '## Branches with work beyond their pull request merge point', '')
  const pastMerge = branches.filter((branch) => branch.pastMerge)
  if (!pastMerge.length) lines.push('None detected.')
  else for (const branch of pastMerge) lines.push(`- \`${branch.name}\`: ${branch.detail}`)
  lines.push('', '## Provably superseded branches and worktrees', '')
  if (!superseded.length) lines.push('None can be proven disposable from the current local and tracker evidence.')
  else for (const branch of superseded) lines.push(`- \`${branch.name}\`${branch.worktree ? ` at \`${branch.worktree}\`` : ''}: PR #${branch.relatedPrNumber} is closed/merged, its content is already on origin/main, and the worktree is clean. Confirm no external owner before removing it.`)
  lines.push('')
  return lines.join('\n')
}

function collect() {
  run('git', ['fetch', 'origin'])
  const issues = ghJson(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body,url,labels']).sort((a, b) => a.number - b.number)
  const prs = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body,isDraft,headRefName,headRefOid,baseRefName,url']).sort((a, b) => a.number - b.number)
  if (issues.length >= 500 || prs.length >= 500) throw new Error('Tracker result reached the 500 item limit; paginate before generating status.')
  const facts = collectGitFacts({ repo })
  if (!facts.pullRequests) throw new Error('Could not read all pull request states; status would be incomplete.')
  if (facts.pullRequests.length >= 500) throw new Error('Pull request history reached the 500 item limit; paginate before generating status.')
  const report = analyseDrift({ ...facts, commandLines: runningCommandLines(), cwd: root })
  const worktrees = facts.worktrees.map((tree) => ({
    ...tree,
    ahead: facts.branches.find((branch) => branch.name === tree.branch)?.ownCommits,
  }))
  const branches = facts.branches.map((branch) => {
    const finding = report.findings.find((item) => item.subject === branch.name)
    const tree = worktrees.find((item) => item.path === branch.worktree)
    return {
      ...branch,
      pastMerge: finding?.check === 'branch-past-merge',
      detail: finding?.message,
      ...branchDisposition(branch, finding, tree, facts.pullRequests ?? []),
    }
  })
  const issueNumbers = [...new Set([
    ...prs.map(linkedIssue).filter(Number.isFinite),
    ...worktrees.map((tree) => Number(/(?:^|[/-])(\d+)(?:-|$)/.exec(tree.branch ?? '')?.[1])).filter(Number.isFinite),
  ])]
  const selections = issueNumbers.map((number) => `issue_${number}: issue(number: ${number}) { comments(last: 100) { nodes { body } } }`)
  const checkSelections = prs.map((pr) => `pr_${pr.number}: pullRequest(number: ${pr.number}) { commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } }`)
  const owner = repo.split('/')[0]
  const name = repo.split('/')[1]
  const graphqlData = selections.length || checkSelections.length
    ? ghJson(['api', 'graphql', '-f', `query=query { repository(owner: "${owner}", name: "${name}") { ${[...selections, ...checkSelections].join(' ')} } }`]).data.repository
    : {}
  const commentsByIssue = new Map(issueNumbers.map((number) => [number, graphqlData[`issue_${number}`]?.comments.nodes ?? []]))
  const checksByPr = new Map(prs.map((pr) => {
    const commits = graphqlData[`pr_${pr.number}`]?.commits.nodes ?? []
    const commit = commits[commits.length - 1]?.commit
    return [pr.number, commit ? { oid: commit.oid, state: commit.statusCheckRollup?.state ?? null } : null]
  }))
  const normalizedWorktrees = omitGeneratedStatusFile(worktrees)
  return { issues, prs, worktrees: normalizedWorktrees, branches, commentsByIssue, checksByPr, generatedFrom: run('git', ['rev-parse', 'origin/main']) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(root, 'docs', 'agents', 'status.md')
  const status = renderStatus(collect())
  let existing = ''
  try { existing = readFileSync(output, 'utf8') } catch {}
  if (existing !== status) writeFileSync(output, status, 'utf8')
  console.log(`${existing === status ? 'Unchanged' : 'Updated'} ${path.relative(root, output)}`)
}
