const heading = (name) => new RegExp(`^##\\s+${name}\\s*$`, 'i')

function sectionLines(markdown, name) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => heading(name).test(line.trim()))
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()))
  return lines.slice(start + 1, end < 0 ? undefined : end)
}

function namedEvidence(value) {
  const match = /^(test|command|human observation)\s*:\s*(.+)$/i.exec(value.trim())
  if (!match) return null
  const detail = match[2].trim().replace(/^`|`$/g, '')
  if (!detail || /^(pending|tbd|todo|none|n\/a)$/i.test(detail)) return null
  return { kind: match[1].toLowerCase(), detail }
}

export function parseAcceptanceCriteria(body = '') {
  return sectionLines(body, 'Acceptance criteria').flatMap((line) => {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    const [source, evidenceSource] = match[2].split(/\s+[—–-]\s+Evidence:\s*/i, 2)
    const id = /^(AC-?\d+)\s*:\s*/i.exec(source)?.[1]?.toUpperCase().replace(/^AC(?=\d)/, 'AC-') ?? null
    const text = id ? source.replace(/^(AC-?\d+)\s*:\s*/i, '').trim() : source.trim()
    const evidence = evidenceSource ? namedEvidence(evidenceSource) : null
    return [{ id, text, checked: match[1].toLowerCase() === 'x', evidence, raw: line.trim() }]
  })
}

function criterionKey(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function parseAcceptanceDeferrals(comments = []) {
  const deferrals = []
  for (const comment of comments) {
    for (const line of sectionLines(comment.body ?? '', 'Deferred acceptance')) {
      const match = /^\s*[-*]\s+(.+?)\s+[—–-]\s+(?:Reason:\s*)?(.+?)\s*$/.exec(line)
      if (match && match[2].trim()) deferrals.push({ target: match[1].trim(), reason: match[2].trim() })
    }
  }
  return deferrals
}

export function acceptanceProgress(body = '', comments = []) {
  const criteria = parseAcceptanceCriteria(body)
  const deferrals = parseAcceptanceDeferrals(comments)
  const rows = criteria.map((criterion) => {
    const targetId = criterion.id
    const targetText = criterionKey(criterion.text)
    const deferred = deferrals.find((item) => {
      const deferralId = /^(AC-?\d+)\b/i.exec(item.target)?.[1]?.toUpperCase().replace(/^AC(?=\d)/, 'AC-')
      if (targetId && deferralId) return targetId === deferralId
      return criterionKey(item.target) === targetText
    })
    const evidenced = criterion.checked && criterion.evidence !== null
    return { ...criterion, evidenced, deferred: deferred ?? null }
  })
  const evidenced = rows.filter((row) => row.evidenced).length
  const deferred = rows.filter((row) => !row.evidenced && row.deferred).length
  return { criteria: rows, total: rows.length, evidenced, remaining: rows.length - evidenced, deferred }
}

export function parseParentStoryNumbers(body = '') {
  return [...new Set(sectionLines(body, 'Parent specification stories')
    .flatMap((line) => [...line.matchAll(/#1\s*(?:story\s+|[.:/])\s*(\d+)/gi)].map((match) => Number(match[1]))))]
}

export function numberedUserStories(parentBody = '') {
  return sectionLines(parentBody, 'User stories')
    .flatMap((line) => /^\s*(\d+)\.\s+As\b/i.exec(line)?.[1] ? [Number(/^\s*(\d+)\.\s+As\b/i.exec(line)[1])] : [])
}

export function acceptanceReport(issues, commentsByIssue = new Map()) {
  return issues.flatMap((issue) => {
    const progress = acceptanceProgress(issue.body ?? '', commentsByIssue.get(issue.number) ?? [])
    return progress.total ? [{ issue, ...progress, stories: parseParentStoryNumbers(issue.body ?? '') }] : []
  })
}

export function acceptanceMergeBlockers(issueBody, comments = []) {
  const progress = acceptanceProgress(issueBody, comments)
  if (progress.total === 0) return ['Issue has no `## Acceptance criteria` checklist.']
  return progress.criteria
    .filter((criterion) => !criterion.evidenced && !criterion.deferred)
    .map((criterion) => `${criterion.id ? `${criterion.id}: ` : ''}${criterion.text}`)
}
