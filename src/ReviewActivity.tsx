import { useEffect, useRef, useState } from 'react'
import { Rating } from './collection'
import { ImageOcclusionReview } from './ImageOcclusion'
import { MediaRenderer } from './MediaRenderer'
import { TemplatePreview } from './TemplatePreview'
import { compareTypedAnswer } from './typed-answer'
import { isShortcutBlocked } from './keyboard-shortcuts'
import type { StudyActivityViewProps } from './learning-activities'

export function ReviewActivity({ session }: StudyActivityViewProps) {
  const { prompt, busy, choices, grade, announceAnswer, cardSurface } = session
  const { card, note, noteType, template, rendering, imageOcclusionImage, attachments, mediaBlocked, mediaError } = prompt
  const [shownAnswerCardId, setShownAnswerCardId] = useState<string | null>(null)
  const [typedDraft, setTypedDraft] = useState<{ cardId: string; value: string } | null>(null)
  const typedResult = useRef<HTMLDivElement>(null)
  const typedAnswer = rendering.typedAnswer
  const answerShown = shownAnswerCardId === card.id
  const typedInput = typedDraft?.cardId === card.id ? typedDraft.value : ''
  const answerDiff = answerShown && typedAnswer !== undefined ? compareTypedAnswer(typedAnswer, typedInput) : []

  useEffect(() => {
    if (answerShown && typedAnswer !== undefined) typedResult.current?.focus()
  }, [answerShown, typedAnswer])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (busy || isShortcutBlocked(event)) return
      const key = event.key.toLowerCase()
      const buttonFocused = event.target instanceof Element && Boolean(event.target.closest('button'))
      if ((key === ' ' || key === 'spacebar') && !answerShown && !buttonFocused) {
        if (mediaBlocked) return
        event.preventDefault()
        announceAnswer()
        setShownAnswerCardId(card.id)
      } else if (answerShown && /^[1-4]$/.test(key)) {
        const choice = choices[Number(key) - 1]
        if (choice) { event.preventDefault(); void grade(card.id, choice.rating) }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [answerShown, busy, choices, grade, mediaBlocked, announceAnswer, card.id])

  return <>
    <article className="review-card" ref={cardSurface}>
      <span className="card-side">{answerShown ? 'ANSWER' : 'QUESTION'}</span>
      <div className="review-card-content">
      {mediaBlocked ? <p role="status">Preparing card media…</p> : noteType.kind === 'image-occlusion'
        ? <ImageOcclusionReview note={note} card={card} showAnswer={answerShown} imageUrl={imageOcclusionImage} />
        : <TemplatePreview title="Review card" study reviewColors key={card.id} rendering={rendering} templateOrdinal={Math.max(1, noteType.templates.findIndex((candidate) => candidate.id === template.id) + 1)} side={answerShown ? 'back' : 'front'} />}
      {mediaError && <p className="form-error" role="alert">Some attachments could not be shown: {mediaError}</p>}
      {!mediaBlocked && noteType.kind !== 'image-occlusion' && attachments.filter((description) => description.side === 'front').map((description) => <MediaRenderer key={description.id} description={description} />)}
      {!mediaBlocked && noteType.kind !== 'image-occlusion' && answerShown && attachments.filter((description) => description.side === 'back').map((description) => <MediaRenderer key={description.id} description={description} />)}
      {typedAnswer !== undefined && !answerShown && <label className="typed-answer">Type your answer
        <input autoComplete="off" value={typedInput} onChange={(event) => setTypedDraft({ cardId: card.id, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (!mediaBlocked) { announceAnswer(); setShownAnswerCardId(card.id) } } }} />
      </label>}
      {typedAnswer !== undefined && answerShown && <div ref={typedResult} className="typed-answer-result" role="status" aria-live="polite" aria-label="Typed answer comparison" tabIndex={-1}>
        <span className="section-code">YOUR ANSWER</span>
        <div className="answer-diff">{answerDiff.map((part, index) => <span key={index} className={`answer-${part.kind}`} aria-label={`${part.kind === 'good' ? 'Correct' : part.kind === 'bad' ? 'Incorrect' : 'Missing'}: ${part.text}`}>{part.text}</span>)}</div>
        <p>Expected: <strong>{typedAnswer}</strong></p>
      </div>}
      </div>
    </article>
    <div className="review-answer-controls">
    {!answerShown ? (
      <button className="primary-action reveal-action" type="button" disabled={busy || mediaBlocked} onClick={() => { announceAnswer(); setShownAnswerCardId(card.id) }}>Show answer</button>
    ) : (
      <div className="rating-grid" role="group" aria-label="Rate answer">
        {choices.map((choice) => (
          <button aria-label={`${choice.label} · ${choice.interval}`} className={`rating rating-${Rating[choice.rating].toLowerCase()}`} type="button" disabled={busy || mediaBlocked} key={choice.rating} onClick={() => { void grade(card.id, choice.rating) }}>
            <strong>{choice.label}</strong><span aria-hidden="true">·</span><small>{choice.interval}</small>
          </button>
        ))}
      </div>
    )}
    </div>
  </>
}
