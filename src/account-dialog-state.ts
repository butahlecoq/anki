export type AccountAction = 'connect' | 'media' | 'resolve' | 'prepare' | 'import'

export function accountActionLabel(action: AccountAction, busyAction: AccountAction | null, idleLabel: string, busyLabel: string) {
  return action === busyAction ? busyLabel : idleLabel
}
