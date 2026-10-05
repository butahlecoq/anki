import { execFileSync } from 'node:child_process'
import { acceptanceMergeBlockers } from './acceptance-evidence.mjs'

function ghJson(args) {
  const output = execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(output)
}

export function issueNumberForPullRequest(pr) {
  return /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(pr.body ?? '')?.[1] ?? null
}

if (process.argv[1]?.endsWith('premerge-acceptance.mjs')) {
  const number = process.argv[2]
  if (!/^\d+$/.test(number ?? '')) {
    console.error('Usage: npm run premerge -- <pull-request-number>')
    process.exitCode = 2
  } else {
    const pr = ghJson(['pr', 'view', number, '--json', 'number,title,body,state'])
    if (pr.state !== 'OPEN') {
      console.error(`PR #${number} is ${pr.state.toLowerCase()}, not open.`)
      process.exitCode = 1
    } else {
      const issueNumber = issueNumberForPullRequest(pr)
      if (!issueNumber) {
        console.error(`PR #${number} does not declare a closing issue with "Closes #<number>".`)
        process.exitCode = 1
      } else {
        const issue = ghJson(['issue', 'view', issueNumber, '--json', 'number,title,body,comments'])
        const blockers = acceptanceMergeBlockers(issue.body, issue.comments ?? [])
        if (blockers.length) {
          console.error(`PR #${number} is blocked by incomplete acceptance on #${issueNumber}:`)
          for (const blocker of blockers) console.error(`- ${blocker}`)
          console.error('Record named evidence by ticking completed criteria, or add an issue comment under "## Deferred acceptance" with an AC ID and a reason for each remaining item.')
          process.exitCode = 1
        } else console.log(`PR #${number} passes the acceptance evidence pre-merge check for #${issueNumber}.`)
      }
    }
  }
}
