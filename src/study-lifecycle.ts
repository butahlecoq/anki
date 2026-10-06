import { useCallback, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Rating, type Collection, type Grade } from './collection'
import { answerCustomStudy, customStudyQueue, practiceChoices } from './custom-study'
import { customStudySessions } from './custom-study-state'
import { userFacingStorageError } from './offline-storage'

/** Shared queue, progression, and review-writing rules for every study activity. */
export function useStudyLifecycle(source: Collection, { deckId, sessionId, cardScope }: { deckId?: string; sessionId?: string; cardScope: 'current' | 'queue' }) {
  const [skippedCardIds, setSkippedCardIds] = useState<ReadonlySet<string>>(() => new Set())
  const [reviewsRecorded, setReviewsRecorded] = useState(0)
  const [isAnswering, setIsAnswering] = useState(false)
  const [actionError, setActionError] = useState('')
  const [reviewAnnouncement, setReviewAnnouncement] = useState('')
  const customSession = useLiveQuery(async () => sessionId ? (await customStudySessions(source)).find((session) => session.id === sessionId) : undefined, [source, sessionId])
  const dueQueue = useLiveQuery(() => sessionId ? customStudyQueue(source, sessionId, new Date()) : source.reviewQueue(deckId ?? '', new Date()), [source, deckId, sessionId])
  const queue = dueQueue?.filter((candidate) => !skippedCardIds.has(candidate.id))
  const cardId = queue?.[0]?.id
  const candidateIds = cardScope === 'queue' ? queue?.map((candidate) => candidate.id) ?? [] : cardId ? [cardId] : []
  const candidateKey = candidateIds.join('\u0000')
  const choicesByCardId = useLiveQuery(async () => Object.fromEntries(await Promise.all(candidateIds.map(async (candidateId) => [
    candidateId,
    sessionId && customSession?.reschedule === false ? practiceChoices : await source.reviewChoices(candidateId, new Date(), Boolean(sessionId)),
  ]))), [source, candidateKey, sessionId, customSession?.reschedule])
  const choices = cardId ? choicesByCardId?.[cardId] ?? [] : []

  const answer = useCallback(async (targetCardId: string, rating: Grade, durationMs: number) => {
    if (!queue?.some((candidate) => candidate.id === targetCardId) || isAnswering) return false
    setIsAnswering(true)
    setActionError('')
    try {
      if (sessionId) await answerCustomStudy(source, sessionId, targetCardId, rating, new Date(), durationMs)
      else await source.answer(targetCardId, rating, new Date(), durationMs)
      setReviewsRecorded((count) => count + 1)
      setReviewAnnouncement(`Recorded ${Rating[rating]}. ${reviewsRecorded + 1} rated this session.`)
      return true
    } catch (reason) {
      setActionError(userFacingStorageError(reason, 'Unable to update card'))
      return false
    } finally {
      setIsAnswering(false)
    }
  }, [source, queue, isAnswering, sessionId, reviewsRecorded])

  const skipCard = useCallback(() => {
    if (!cardId) return
    setSkippedCardIds((current) => new Set(current).add(cardId))
    setReviewAnnouncement('Card skipped. It stays scheduled and comes back later.')
  }, [cardId])

  return {
    customSession,
    dueQueue,
    queue,
    cardId,
    choices,
    choicesByCardId: choicesByCardId ?? {},
    choicesLoading: choicesByCardId === undefined,
    reviewsRecorded,
    setReviewsRecorded,
    isAnswering,
    setIsAnswering,
    actionError,
    setActionError,
    reviewAnnouncement,
    setReviewAnnouncement,
    answer,
    skipCard,
  }
}
