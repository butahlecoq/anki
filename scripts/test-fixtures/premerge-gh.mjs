import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Substitute only the external tracker transport in the real CLI subprocess.
const fixture = JSON.parse(process.env.PREMERGE_TEST_FIXTURE)
childProcess.execFileSync = (command, args) => {
  if (command !== 'gh') throw new Error(`Unexpected command: ${command}`)
  appendFileSync(process.env.PREMERGE_TEST_CALLS, JSON.stringify(args) + '\n')
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(fixture.pr)
  if (args[0] === 'issue' && args[1] === 'view') {
    const issue = fixture.issues[args[2]]
    if (!issue) throw new Error(`Unexpected issue: ${args[2]}`)
    return JSON.stringify(issue)
  }
  throw new Error(`Unexpected gh arguments: ${JSON.stringify(args)}`)
}
syncBuiltinESMExports()
