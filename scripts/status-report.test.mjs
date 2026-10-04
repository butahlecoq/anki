import test from 'node:test'
import assert from 'node:assert/strict'
import { branchDisposition, checkState, deferredLines, omitGeneratedStatusFile, renderStatus } from './status-report.mjs'

const issue = { number: 42, title: 'Keep deferred acceptance visible', url: 'https://github.com/butahlecoq/anki/issues/42' }
const pr = {
  number: 43,
  title: 'Checkpoint for #42',
  body: 'Progress on #42. The installed phone journey remains deferred until a human device check.',
  isDraft: false,
  headRefName: 'feat/42-checkpoint',
  headRefOid: 'abc123',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  url: 'https://github.com/butahlecoq/anki/pull/43',
}

test('status names the matching issue PR, current-head checks, deferral, and worktree', () => {
  const input = {
    issues: [issue],
    prs: [pr],
    worktrees: [{ branch: pr.headRefName, path: 'D:/work/anki-42', dirtyFiles: [], untrackedFiles: [] }],
    branches: [],
    commentsByIssue: new Map(),
    generatedFrom: 'deadbeef',
  }
  input.checksByPr = new Map([[pr.number, { oid: pr.headRefOid, state: 'SUCCESS' }]])
  const output = renderStatus(input)
  assert.match(output, /#43/)
  assert.match(output, /passed on exact head/)
  assert.match(output, /remains deferred/)
  assert.match(output, /D:\/work\/anki-42/)
  assert.equal(renderStatus(input), output)
})

test('status exposes dirty worktrees and distinguishes retained branches from proven superseded branches', () => {
  const output = renderStatus({
    issues: [],
    prs: [],
    worktrees: [{ branch: 'feat/7-dirty', path: 'D:/work/anki-7', dirtyFiles: ['src/app.ts'], untrackedFiles: [] }],
    branches: [
      { name: 'feat/8-old', worktree: null, disposition: 'provably disposable' },
      { name: 'feat/9-unknown', worktree: 'D:/work/anki-9', disposition: 'retain' },
      { name: 'feat/10-past', pastMerge: true, detail: 'PR #10 merged but branch has new work' },
    ],
    generatedFrom: 'deadbeef',
  })
  assert.match(output, /src\/app\.ts/)
  assert.match(output, /feat\/8-old.*Confirm no external owner/)
  assert.doesNotMatch(output, /feat\/9-unknown.*Confirm no external owner/)
  assert.match(output, /feat\/10-past.*PR #10 merged/)
})

test('an in-flight branch without a PR says checks are not applicable and still reports checkpoint deferrals', () => {
  const output = renderStatus({
    issues: [issue],
    prs: [],
    worktrees: [{ branch: 'feat/42-checkpoint', path: 'D:/work/anki-42', dirtyFiles: [], untrackedFiles: [], ahead: 3 }],
    branches: [],
    commentsByIssue: new Map([[42, [{ body: '## Deferred acceptance\n- Obtain the reviewed full gate result.' }]]]),
    generatedFrom: 'deadbeef',
  })
  assert.match(output, /No open PR; exact-head checks: not applicable/)
  assert.match(output, /local commits ahead of origin\/main: 3/)
  assert.match(output, /Obtain the reviewed full gate result/)
})

test('check state never calls an empty hosted check set a pass', () => {
  const pr = { headRefOid: 'abc' }
  assert.equal(checkState(pr, { oid: 'abc', state: null }), 'no hosted checks reported')
  assert.equal(checkState(pr, { oid: 'abc', state: 'PENDING' }), 'pending')
  assert.equal(checkState(pr, { oid: 'abc', state: 'FAILURE' }), 'failing')
  assert.equal(checkState(pr, { oid: 'old-head', state: 'SUCCESS' }), 'could not verify exact PR head')
  assert.equal(checkState(pr), 'could not verify exact PR head')
})

test('deferred work is limited to explicit PR evidence and checkpoint comment sections', () => {
  const lines = deferredLines(
    { body: 'A partial checkpoint. Acceptance remains open for device proof.' },
    [
      { body: 'Old narrated handoff with unrelated blocked work.' },
      { body: '## Deferred by checkpoint\n- Verify a real device journey.\n- Obtain independent review.\n\n## Evidence\n- The focused tests passed.' },
    ],
  )
  assert.deepEqual(lines, [
    'A partial checkpoint. Acceptance remains open for device proof.',
    '- Verify a real device journey.',
    '- Obtain independent review.',
  ])
  assert.deepEqual(deferredLines({ body: 'A summary mentions deferred acceptance comments.\n\n## Deferred acceptance\n- Run the final local gate.\n\n## Verification\n- focused checks passed.' }), ['- Run the final local gate.'])
})

test('outstanding sections include all issue acceptance without matching completed pending-file coverage', () => {
  const result = deferredLines(
    { body: '## Coverage\n- Malformed ZIP rejection preserves the pending file and cursor.\n\n## Outstanding #56 work\n- Add visible account status and logout.\n- Verify writeback recovery after restart.\n\n## Verification\n- Focused tests passed.' },
    [{ body: '## Remaining #94 acceptance\n- Compare persisted Learning, Review, and Relearning outcomes against native Anki.\n\n## Deferred gate\n- Run the full local gate after #85 releases capacity.' }],
  )
  assert.deepEqual(result, [
    '- Add visible account status and logout.',
    '- Verify writeback recovery after restart.',
    '- Compare persisted Learning, Review, and Relearning outcomes against native Anki.',
    '- Run the full local gate after #85 releases capacity.',
  ])
})

test('historical acceptance sections do not leak generic open lines or truncate later criteria', () => {
  const comments = [
    { body: '## Outstanding acceptance\n- First criterion.\n- Second criterion.\n- Third criterion.\n- Fourth criterion.\n- Fifth criterion.\n- Sixth criterion.\n- Seventh criterion.\n- Eighth criterion.\n- Ninth criterion.\n- Tenth criterion.\n- Eleventh criterion.\nIssue #56 remains open after checkpoint merge.\n\n## Evidence\n- Five focused tests passed.' },
  ]
  const result = deferredLines({}, comments)
  assert.equal(result.length, 11)
  assert.ok(result.includes('- Eleventh criterion.'))
  assert.ok(result.every((line) => !/^Issue #\d+ remains open/.test(line)))
  assert.ok(result.every((line) => !/focused tests passed/.test(line)))
})

test('explicit acceptance sections keep a separate inline full-gate deferral', () => {
  const result = deferredLines({
    body: '## Verification\n- The complete npm run check is deferred until verification capacity is released.\n\n## Outstanding #56 work\n- Add visible account status and logout.',
  })
  assert.deepEqual(result, [
    '- Add visible account status and logout.',
    '- The complete npm run check is deferred until verification capacity is released.',
  ])
})

test('inline non-zero gate results and outstanding checks remain visible', () => {
  const result = deferredLines({
    body: 'The final default `npm run check` remains non-zero: `83 passed, 6 failed, 9 skipped` in the browser stage.\n\nPhysical installed-Safari checks remain outstanding.',
  })
  assert.deepEqual(result, [
    'The final default `npm run check` remains non-zero: `83 passed, 6 failed, 9 skipped` in the browser stage.',
    'Physical installed-Safari checks remain outstanding.',
  ])
  assert.deepEqual(deferredLines({
    body: 'No physical installed-Safari checks remain outstanding.\nThe checks do not remain outstanding after this patch.\nThis gate does not remain non-zero.',
  }), [])
  assert.deepEqual(deferredLines({
    body: 'This is not yet validated; physical checks remain outstanding.\nNo earlier build passed, but this gate remains non-zero.',
  }), [
    'This is not yet validated; physical checks remain outstanding.',
    'No earlier build passed, but this gate remains non-zero.',
  ])
})

test('a branch is called disposable only when a closed or merged PR is accounted for on main and its worktree is clean', () => {
  const branch = { name: 'feat/8-old' }
  const finding = { check: 'branch-stale-snapshot', provenOnMain: true }
  const merged = [{ number: 12, headRefName: branch.name, state: 'MERGED', updatedAt: '2026-10-01' }]
  assert.deepEqual(branchDisposition(branch, finding, null, []), { disposition: 'retain', relatedPrNumber: undefined })
  assert.deepEqual(branchDisposition(branch, finding, { dirtyFiles: [], untrackedFiles: [] }, merged), { disposition: 'provably disposable', relatedPrNumber: 12 })
  assert.deepEqual(branchDisposition({ ...branch, provenOnMain: true }, { check: finding.check }, { dirtyFiles: [], untrackedFiles: [] }, merged), { disposition: 'provably disposable', relatedPrNumber: 12 })
  assert.equal(branchDisposition(branch, finding, { dirtyFiles: ['file'], untrackedFiles: [] }, merged).disposition, 'retain')
  assert.equal(branchDisposition(branch, { check: 'branch-past-merge' }, null, merged).disposition, 'retain')
})

test('deletion-only stale snapshots are retained until their content is proven on main', () => {
  const branch = { name: 'feat/8-old', additions: 0, deletions: 40, binary: 0 }
  const merged = [{ number: 12, headRefName: branch.name, state: 'MERGED', updatedAt: '2026-10-01' }]
  assert.equal(branchDisposition(branch, { check: 'branch-stale-snapshot' }, null, merged).disposition, 'retain')
  assert.equal(branchDisposition(branch, { check: 'branch-stale-snapshot', provenOnMain: true }, { dirtyFiles: [], untrackedFiles: [] }, merged).disposition, 'provably disposable')
})

test('the generated report never marks itself dirty in its own worktree', () => {
  const trees = omitGeneratedStatusFile([
    { path: 'D:/repo', dirtyFiles: ['src/app.ts'], untrackedFiles: ['docs/agents/status.md'] },
    { path: 'D:/repo-other', dirtyFiles: [], untrackedFiles: ['docs/agents/status.md'] },
  ], 'D:\\repo')
  assert.deepEqual(trees[0].dirtyFiles, ['src/app.ts'])
  assert.deepEqual(trees[0].untrackedFiles, [])
  assert.deepEqual(trees[1].untrackedFiles, ['docs/agents/status.md'])
})

test('PR worktree matching uses the exact branch even when the branch name has another issue number', () => {
  const output = renderStatus({
    issues: [issue],
    prs: [{ ...pr, headRefName: 'feat/99-shared-name' }],
    worktrees: [
      { branch: 'feat/42-other', path: 'D:/work/anki-42', dirtyFiles: [], untrackedFiles: [] },
      { branch: 'feat/99-shared-name', path: 'D:/work/anki-99', dirtyFiles: [], untrackedFiles: [] },
    ],
    branches: [],
    generatedFrom: 'deadbeef',
  })
  assert.match(output, /feat\/99-shared-name.*D:\/work\/anki-99/)
  assert.doesNotMatch(output, /feat\/99-shared-name.*D:\/work\/anki-42/)
})

test('open PRs linked to a closed issue remain visible, including fork heads', () => {
  const output = renderStatus({
    issues: [],
    prs: [
      { ...pr, number: 44, title: 'Fixes #999', headRepositoryOwner: { login: 'butahlecoq' } },
      { ...pr, number: 45, title: 'Fixes #998', headRepositoryOwner: { login: 'contributor' } },
    ],
    worktrees: [{ branch: pr.headRefName, path: 'D:/work/anki-42', dirtyFiles: [], untrackedFiles: [] }],
    branches: [],
    generatedFrom: 'deadbeef',
    repoOwner: 'butahlecoq',
  })
  assert.match(output, /## Open PRs without an open issue[\s\S]*#44[\s\S]*#45/)
})

test('a fork PR remains under its open issue without claiming a local worktree', () => {
  const output = renderStatus({
    issues: [issue],
    prs: [{ ...pr, headRepositoryOwner: { login: 'contributor' } }],
    worktrees: [{ branch: pr.headRefName, path: 'D:/work/anki-42', dirtyFiles: [], untrackedFiles: [] }],
    branches: [],
    generatedFrom: 'deadbeef',
    repoOwner: 'butahlecoq',
  })
  assert.match(output, /#43[\s\S]*worktree: not registered/)
  assert.doesNotMatch(output, /## Open PRs without an open issue[\s\S]*#43/)
})
