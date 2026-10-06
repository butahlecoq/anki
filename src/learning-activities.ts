import type { ComponentType, RefObject } from 'react'
import type { CardMediaDescription, RenderedCard } from './card-rendering'
import type { CardRecord, CardTemplate, Grade, Note, NoteType, ReviewChoice } from './collection'
import { matchingUnsupportedReason } from './matching-requirements'
import { MatchingActivity } from './MatchingActivity'
import { ReviewActivity } from './ReviewActivity'

export const DEFAULT_LEARNING_ACTIVITY_ID = 'review'

export interface StudyActivityPrompt {
  card: CardRecord
  note: Note
  noteType: NoteType
  template: CardTemplate
  rendering: RenderedCard
  imageOcclusionImage?: string
  attachments: readonly CardMediaDescription[]
  mediaBlocked: boolean
  mediaError?: string
}

export interface StudyActivityCandidate {
  prompt: StudyActivityPrompt
  unsupportedReason?: string
}

export interface StudyActivityViewProps {
  session: {
    prompt: StudyActivityPrompt
    candidates: readonly StudyActivityCandidate[]
    candidatesLoading: boolean
    choicesLoading: boolean
    minimumCandidateCount: number
    busy: boolean
    choices: readonly ReviewChoice[]
    choicesFor(cardId: string): readonly ReviewChoice[]
    grade(cardId: string, rating: Grade): Promise<boolean>
    announceAnswer(): void
    cardSurface: RefObject<HTMLElement | null>
  }
}

export interface LearningActivityDefinition {
  id: string
  title: string
  description: string
  cardScope: 'current' | 'queue'
  completion: 'queue' | 'activity'
  minimumCandidateCount: number
  unsupportedReason(prompt: StudyActivityPrompt): string | undefined
  View: ComponentType<StudyActivityViewProps>
}

export const learningActivities: readonly LearningActivityDefinition[] = [
  {
    id: DEFAULT_LEARNING_ACTIVITY_ID,
    title: 'Review cards',
    description: 'See each card, reveal its answer, and choose Again, Hard, Good, or Easy.',
    cardScope: 'current',
    completion: 'queue',
    minimumCandidateCount: 1,
    unsupportedReason: () => undefined,
    View: ReviewActivity,
  },
  {
    id: 'matching',
    title: 'Match cards',
    description: 'Match card prompts to answers, then choose a separate review grade.',
    cardScope: 'queue',
    completion: 'activity',
    minimumCandidateCount: 2,
    unsupportedReason: matchingUnsupportedReason,
    View: MatchingActivity,
  },
]

export function learningActivity(id: string | undefined) {
  return learningActivities.find((activity) => activity.id === (id ?? DEFAULT_LEARNING_ACTIVITY_ID))
}

export function isLearningActivityId(id: string | undefined): id is string {
  return learningActivities.some((activity) => activity.id === id)
}
