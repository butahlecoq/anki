import type { ComponentType, RefObject } from 'react'
import type { CardMediaDescription, RenderedCard } from './card-rendering'
import type { CardRecord, CardTemplate, Grade, Note, NoteType, ReviewChoice } from './collection'
import { ReviewActivity } from './ReviewActivity'

export const DEFAULT_LEARNING_ACTIVITY_ID = 'review'

export interface StudyActivityViewProps {
  session: {
    prompt: {
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
    busy: boolean
    choices: readonly ReviewChoice[]
    grade(rating: Grade): void
    announceAnswer(): void
    cardSurface: RefObject<HTMLElement | null>
  }
}

export interface LearningActivityDefinition {
  id: string
  title: string
  description: string
  View: ComponentType<StudyActivityViewProps>
}

export const learningActivities: readonly LearningActivityDefinition[] = [
  {
    id: DEFAULT_LEARNING_ACTIVITY_ID,
    title: 'Review cards',
    description: 'See each card, reveal its answer, and choose Again, Hard, Good, or Easy.',
    View: ReviewActivity,
  },
]

export function learningActivity(id: string | undefined) {
  return learningActivities.find((activity) => activity.id === (id ?? DEFAULT_LEARNING_ACTIVITY_ID))
}

export function isLearningActivityId(id: string | undefined): id is string {
  return learningActivities.some((activity) => activity.id === id)
}
