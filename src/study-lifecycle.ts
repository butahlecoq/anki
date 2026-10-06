import { useCallback, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Rating, type Collection, type Grade } from './collection'
import { answerCustomStudy, customStudyQueue, practiceChoices } from './custom-study'
import { customStudySessions } from './custom-study-state'
import { userFacingStorageError } from './offline-storage'

/** Shared queue, progression, and review-writing rules for every study activity. */
export function useStudyLifecycle(source: Collection, { deckId, sessionId }: { deckId?: string; sessionId?: string }) {
  const [skippedCardIds, setSkippedCardIds] = useState<ReadonlySet<string>>(() => new Set())
  const [reviewsRecorded, setReviewsRecorded] = useState(0)
  const [isAnswering, setIsAnswering] = useState(false)
  const [actionError, setActionError] = useState('')
  const [reviewAnnouncement, setReviewAnnouncement] = useState('')
  const customSession = useLiveQuery(async () => sessionId ? (await customStudySessions(source)).find((session) => session.id === sessionId) : undefined, [source, sessionId])
  const dueQueue = useLiveQuery(() => sessionId ? customStudyQueue(source, sessionId, new Date()) : source.reviewQueue(deckId ?? '', new Date()), [source, deckId, sessionId])
  const queue = dueQueue?.filter((candidate) => !skippedCardIds.has(candidate.id))
  const cardId = queue?.[0]?.id
  const choices = useLiveQuery(() => cardId ? sessionId && customSession?.reschedule === false ? practiceChoices : source.reviewChoices(cardId, new Date(), Boolean(sessionId)) : [], [source, cardId, sessionId, customSession?.reschedule], [])

  const answer = useCallback(async (rating: Grade, durationMs: number) => {
    if (!cardId || isAnswering) return false
    setIsAnswering(true)
    setActionError('')
    try {
      if (sessionId) await answerCustomStudy(source, sessionId, cardId, rating, new Date(), durationMs)
      else await source.answer(cardId, rating, new Date(), durationMs)
      setReviewsRecorded((count) => count + 1)
      setReviewAnnouncement(`Recorded ${Rating[rating]}. ${reviewsRecorded + 1} rated this session.`)
      return true
    } catch (reason) {
      setActionError(userFacingStorageError(reason, 'Unable to update card'))
      return false
    } finally {
      setIsAnswering(false)
    }
  }, [source, cardId, isAnswering, sessionId, reviewsRecorded])

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
