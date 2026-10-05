import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  acceptanceMergeBlockers,
  acceptanceProgress,
  acceptanceReport,
  numberedUserStories,
  parseAcceptanceCriteria,
} from './acceptance-evidence.mjs'

test('only checked acceptance criteria with a named test, command, or observation count as evidenced', () => {
  const body = `## Acceptance criteria
- [x] AC-01: Test is named — Evidence: test: \`src/a.test.ts > works\`
- [x] AC-02: Command is named — Evidence: command: \`npm run check\`
- [x] AC-03: Observation is recorded — Evidence: human observation: reviewer saw the result on device
- [x] AC-04: Missing proof — Evidence: pending
- [ ] AC-05: Not complete — Evidence: test: \`src/a.test.ts > later\`
\n+## Blocked by
None`
  const parsed = parseAcceptanceCriteria(body)
  assert.equal(parsed.length, 5)
  const progress = acceptanceProgress(body)
  assert.deepEqual({ total: progress.total, evidenced: progress.evidenced, remaining: progress.remaining }, { total: 5, evidenced: 3, remaining: 2 })
})

test('deferrals must name the criterion and give a reason before the merge guard permits it', () => {
  const body = `## Acceptance criteria
- [ ] AC-01: Visible account flow works — Evidence: pending
- [ ] AC-02: Export remains lossless — Evidence: pending`
  const comments = [{ body: `## Deferred acceptance\n- AC-01 — Physical iPhone evidence is reserved for the release ticket.` }]
  const progress = acceptanceProgress(body, comments)
  assert.equal(progress.deferred, 1)
  assert.deepEqual(acceptanceMergeBlockers(body, comments), ['AC-02: Export remains lossless'])
  assert.deepEqual(acceptanceMergeBlockers(body, [{ body: 'The rest is deferred.' }]).length, 2)
})

test('issue progress reports every acceptance item and parent story coverage needs evidence for all criteria', () => {
  const parentBody = `## User Stories\n1. As the learner, I want a shell.\n2. As the learner, I want offline study.`
  const issues = [
    { number: 10, title: 'Shell', body: `## Parent specification stories\n- #1 Story 1 — Shell\n\n## Acceptance criteria\n- [x] AC-01: Shell loads — Evidence: command: \`npm run build\`` },
    { number: 11, title: 'Offline', body: `## Parent specification stories\n- #1 Story 2 — Offline\n\n## Acceptance criteria\n- [ ] AC-01: Offline review — Evidence: pending` },
  ]
  const rows = acceptanceReport(issues)
  assert.equal(numberedUserStories(parentBody).length, 2)
  assert.deepEqual(rows.map(({ issue, evidenced, remaining }) => [issue.number, evidenced, remaining]), [[10, 1, 0], [11, 0, 1]])
  assert.deepEqual(rows.filter((row) => row.remaining === 0).flatMap((row) => row.stories), [1])
})

test('a checked item without the standard evidence field does not pass the merge guard', () => {
  const body = '## Acceptance criteria\n- [x] AC-01: Looks done'
  assert.deepEqual(acceptanceMergeBlockers(body), ['AC-01: Looks done'])
})

test('the ready-for-agent issue template requires parent-story references and evidence-ready criteria', () => {
  const template = readFileSync(new URL('../.github/ISSUE_TEMPLATE/ready-for-agent.md', import.meta.url), 'utf8')
  const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8')
  const triage = readFileSync(new URL('../docs/agents/triage-labels.md', import.meta.url), 'utf8')
  assert.match(template, /## Parent specification stories/)
  assert.match(template, /#1 Story <number>/)
  assert.match(template, /## Acceptance criteria/)
  assert.match(template, /AC-01/)
  assert.match(template, /Evidence: pending/)
  assert.match(contributing, /npm run premerge/)
  assert.match(triage, /A completed item is ticked only when the same line records a named test/)
})
