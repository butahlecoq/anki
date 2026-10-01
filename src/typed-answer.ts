export interface AnswerDiffPart {
  kind: 'good' | 'bad' | 'missed'
  text: string
}

const graphemes = (value: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.trim().normalize('NFC'))].map((part) => part.segment)

/** Keep matching context and show the differing middle from each answer. */
export function compareTypedAnswer(expected: string, entered: string): AnswerDiffPart[] {
  const correct = graphemes(expected)
  const actual = graphemes(entered)
  let prefix = 0
  while (prefix < correct.length && prefix < actual.length && correct[prefix] === actual[prefix]) prefix += 1
  let suffix = 0
  while (suffix < correct.length - prefix && suffix < actual.length - prefix && correct[correct.length - suffix - 1] === actual[actual.length - suffix - 1]) suffix += 1
  const parts: AnswerDiffPart[] = []
  if (prefix) parts.push({ kind: 'good', text: correct.slice(0, prefix).join('') })
  const bad = actual.slice(prefix, actual.length - suffix).join('')
  const missed = correct.slice(prefix, correct.length - suffix).join('')
  if (bad) parts.push({ kind: 'bad', text: bad })
  if (missed) parts.push({ kind: 'missed', text: missed })
  if (suffix) parts.push({ kind: 'good', text: correct.slice(correct.length - suffix).join('') })
  return parts
}
