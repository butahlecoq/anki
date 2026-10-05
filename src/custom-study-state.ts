import type { Collection } from './collection'
import { readCustomStudySessions } from './collection-queries'

export const customStudyKey = 'customStudySessions'
export type CustomStudyOrder = 'due' | 'added' | 'random' | 'forgotten'
export interface CustomStudySession {
  id: string
  name: string
  search: string
  limit: number
  order: CustomStudyOrder
  reschedule: boolean
  cardIds: string[]
  completed: Array<{ cardId: string; reviewId: string }>
  createdAt: string
}
export function customStudySessions(db: Collection) {
  return readCustomStudySessions(db, customStudyKey)
}
export function customStudyMembership(db: Collection) {
  return customStudySessions(db).then(sessions => new Map(sessions.flatMap(session => session.cardIds.map(id => [id, session.name] as const))))
}
