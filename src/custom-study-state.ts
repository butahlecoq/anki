import type { Collection } from './collection'

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
  return db.settings.get(customStudyKey).then(record => record?.value as CustomStudySession[] | undefined ?? [])
}
export function customStudyMembership(db: Collection) {
  return customStudySessions(db).then(sessions => new Map(sessions.flatMap(session => session.cardIds.map(id => [id, session.name] as const))))
}