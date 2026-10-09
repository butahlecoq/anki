import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenced = '## Acceptance criteria\n- [x] AC-01: Review works — Evidence: test: reviewer renders the next card'
const incomplete = '## Acceptance criteria\n- [ ] AC-02: Export works'

function runPremerge(body, issues, { state = 'OPEN', number = '50' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kiroku-premerge-'))
  const callsPath = join(directory, 'calls.jsonl')
  try {
    const result = spawnSync(process.execPath, [
      '--import', new URL('./test-fixtures/premerge-gh.mjs', import.meta.url).href,
      fileURLToPath(new URL('./premerge-acceptance.mjs', import.meta.url)), number,
    ], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PREMERGE_TEST_CALLS: callsPath, PREMERGE_TEST_FIXTURE: JSON.stringify({
        pr: { number: 50, title: 'Synthetic qualification', body, state },
        issues: Object.fromEntries(Object.entries(issues).map(([id, issue]) => [id, {
          number: Number(id), title: `Synthetic issue ${id}`, body: issue.body, comments: issue.comments ?? [],
        }])),
      }) },
    })
    if (result.error) throw result.error
    const calls = number === 'invalid' ? [] : readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse)
    return { ...result, issueReads: calls.filter(args => args[0] === 'issue').map(args => args[2]) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a later incomplete closing issue blocks the CLI even when the first issue is evidenced', () => {
  const result = runPremerge('Closes #10. Fixes #11.', { 10: { body: evidenced }, 11: { body: incomplete } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#11/)
  assert.match(result.stderr, /AC-02: Export works/)
})

test('every unique closing issue is checked once and reported on success', () => {
  const result = runPremerge('Closes #10. FIXES #11. resolves #12. Fixes #10.', {
    10: { body: evidenced }, 11: { body: evidenced }, 12: { body: evidenced },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.issueReads, ['10', '11', '12'])
  for (const issue of ['#10', '#11', '#12']) assert.ok(result.stdout.includes(issue))
})

test('one evidenced closing issue retains the normal successful CLI behavior', () => {
  const result = runPremerge('Closes #10.', { 10: { body: evidenced } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /passes.*#10/)
})

test('a valid named deferral permits a later issue without weakening evidence requirements', () => {
  const result = runPremerge('Closes #10. Closes #11.', {
    10: { body: evidenced },
    11: { body: incomplete, comments: [{ body: '## Deferred acceptance\n- AC-02 — Physical-device confirmation remains on the release ticket.' }] },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /#11/)
})

test('checked but unevidenced criteria and unqualified deferral prose still block later issues', () => {
  const result = runPremerge('Closes #10. Closes #11.', {
    10: { body: evidenced },
    11: { body: '## Acceptance criteria\n- [x] AC-02: Export works — Evidence: pending', comments: [{ body: 'Everything else is deferred.' }] },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#11/)
  assert.match(result.stderr, /AC-02: Export works/)
})

test('a later issue without a checklist blocks the CLI', () => {
  const result = runPremerge('Closes #10. Closes #11.', { 10: { body: evidenced }, 11: { body: 'No checklist here.' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#11/)
  assert.match(result.stderr, /no.*Acceptance criteria.*checklist/)
})

test('all incomplete issues are identified even when the first issue already blocks', () => {
  const result = runPremerge('Closes #10. Closes #11.', { 10: { body: incomplete }, 11: { body: incomplete } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /#10/)
  assert.match(result.stderr, /#11/)
  assert.deepEqual(result.issueReads, ['10', '11'])
})

test('unlinked, closed and invalid PR requests remain rejected without reading issues', () => {
  for (const [body, options, status, message] of [
    ['Related to #10.', {}, 1, /does not declare a closing issue/],
    ['Closes #10.', { state: 'MERGED' }, 1, /not open/],
    ['Closes #10.', { number: 'invalid' }, 2, /Usage:/],
  ]) {
    const result = runPremerge(body, {}, options)
    assert.equal(result.status, status)
    assert.match(result.stderr, message)
    assert.deepEqual(result.issueReads, [])
  }
})
