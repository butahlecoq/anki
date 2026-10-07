import { useState } from 'react'
import { Rating, type Grade } from './collection'
import { TemplatePreview } from './TemplatePreview'
import type { StudyActivityCandidate, StudyActivityViewProps } from './learning-activities'

function promptLabel(candidate: StudyActivityCandidate, index: number) {
  return `Prompt ${index + 1} · ${candidate.prompt.note.fields.front ?? candidate.prompt.note.fields.Expression ?? candidate.prompt.card.id}`
}

export function MatchingActivity({ session }: StudyActivityViewProps) {
  const { candidates, candidatesLoading, choicesLoading, choicesFor, grade, busy } = session
  const [started, setStarted] = useState(false)
  const [run, setRun] = useState<StudyActivityCandidate[]>([])
  const [runTotal, setRunTotal] = useState(0)
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null)
  const [matchedCardId, setMatchedCardId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [matching, setMatching] = useState(false)

  const supported = candidates.filter((candidate) => !candidate.unsupportedReason)
  const unsupported = candidates.filter((candidate) => candidate.unsupportedReason)
  const remaining = run
  const selectedPrompt = remaining.find((candidate) => candidate.prompt.card.id === selectedPromptId)
  const selectedPromptIndex = remaining.findIndex((candidate) => candidate.prompt.card.id === selectedPromptId)
  const answerOrder = [...remaining].reverse()

  function start() {
    if (supported.length < session.minimumCandidateCount) return
    setRun(supported)
    setRunTotal(supported.length)
    setStarted(true)
    setFeedback('Choose a prompt, then choose the matching answer.')
  }

  async function chooseAnswer(cardId: string) {
    if (!selectedPromptId || !selectedPrompt || matching) return
    if (selectedPromptId !== cardId) {
      setFeedback('That answer does not match. Try another answer.')
      return
    }
    setMatchedCardId(cardId)
    setFeedback(`Correct match for ${promptLabel(selectedPrompt, selectedPromptIndex)}. Choose a review grade.`)
  }

  async function submitGrade(rating: Grade) {
    if (!matchedCardId || matching) return
    setMatching(true)
    const accepted = await grade(matchedCardId, rating)
    setMatching(false)
    if (!accepted) {
      setFeedback('The review could not be recorded. This pair is still available to try again.')
      setMatchedCardId(null)
      return
    }
    setRun((current) => current.filter((candidate) => candidate.prompt.card.id !== matchedCardId))
    setSelectedPromptId(null)
    setMatchedCardId(null)
    setFeedback('Review recorded. Match the next pair.')
  }

  if (!started) return <section className="matching-activity" aria-labelledby="matching-title">
    <h1 id="matching-title">Match cards</h1>
    <p>Match each prompt to its answer. Your response does not choose your review grade.</p>
    <p role="status">{candidatesLoading || choicesLoading ? 'Preparing selected card content and review grades…' : `${supported.length} compatible ${supported.length === 1 ? 'pair' : 'pairs'} · ${unsupported.length} excluded`}</p>
    {unsupported.length > 0 && <section aria-labelledby="matching-exclusions-title">
      <h2 id="matching-exclusions-title">Cards this activity cannot use</h2>
      <ul>{[...new Set(unsupported.map((candidate) => candidate.unsupportedReason))].map((reason) => <li key={reason}>{unsupported.filter((candidate) => candidate.unsupportedReason === reason).length}: {reason}</li>)}</ul>
    </section>}
    {!candidatesLoading && supported.length < session.minimumCandidateCount && <p role="status">Matching needs at least {session.minimumCandidateCount} compatible pairs. Add or select more compatible cards before starting.</p>}
    <button className="primary-action" type="button" disabled={candidatesLoading || choicesLoading || supported.length < session.minimumCandidateCount} onClick={start}>Start matching</button>
  </section>

  if (!remaining.length) return <section className="matching-activity" aria-labelledby="matching-title">
    <h1 id="matching-title">Matching complete</h1>
    <p role="status">All {runTotal} supported pairs were matched and graded. Excluded cards were left unchanged.</p>
  </section>

  return <section className="matching-activity" aria-labelledby="matching-title">
    <h1 id="matching-title">Match cards</h1>
    <p>{remaining.length} pairs remaining. Select a prompt, then its answer.</p>
    <div className="matching-columns">
      <section aria-labelledby="matching-prompts-title">
        <h2 id="matching-prompts-title">Prompts</h2>
        {remaining.slice(0, 1).map((candidate, index) => <article className="matching-option" key={candidate.prompt.card.id}>
          <TemplatePreview title={`Matching prompt ${index + 1}`} reviewColors rendering={candidate.prompt.rendering} side="front" />
          <button type="button" className="text-button" disabled={Boolean(matchedCardId) || busy} aria-pressed={selectedPromptId === candidate.prompt.card.id} onClick={() => { setSelectedPromptId(candidate.prompt.card.id); setFeedback(`Prompt ${index + 1} selected. Choose its answer.`) }}>Choose prompt {index + 1}</button>
        </article>)}
      </section>
      <section aria-labelledby="matching-answers-title">
        <h2 id="matching-answers-title">Answers</h2>
        {answerOrder.map((candidate) => {
          const index = remaining.findIndex((item) => item.prompt.card.id === candidate.prompt.card.id)
          return <article className="matching-option" key={candidate.prompt.card.id}>
            <TemplatePreview title={`Matching answer ${index + 1}`} reviewColors rendering={candidate.prompt.rendering} side="back" />
            <button type="button" className="text-button" disabled={!selectedPromptId || Boolean(matchedCardId) || busy} onClick={() => void chooseAnswer(candidate.prompt.card.id)}>Choose answer {index + 1}</button>
          </article>
        })}
      </section>
    </div>
    {matchedCardId && <div className="rating-grid" role="group" aria-label="Choose review grade">
      {choicesFor(matchedCardId).map((choice) => <button key={choice.rating} type="button" aria-label={`${choice.label} · ${choice.interval}`} className={`rating rating-${Rating[choice.rating].toLowerCase()}`} disabled={busy || matching} onClick={() => void submitGrade(choice.rating)}>
        <strong>{choice.label}</strong><span aria-hidden="true">·</span><small>{choice.interval}</small>
      </button>)}
    </div>}
    {feedback && <p className="matching-feedback" role="status">{feedback}</p>}
  </section>
}
