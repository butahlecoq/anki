/*
 * Workspace keyboard shortcuts.
 *
 * Two surfaces bind single-key shortcuts: the reviewer in
 * CollectionWorkspace.tsx and the deck workspace in the same file. They share
 * this guard so a key cannot become live in one place and stay dead in the
 * other, and so a shortcut can never fire behind a dialog or inside a field the
 * learner is typing into.
 */

export const SHORTCUT_DIALOG_SELECTOR = '[role="dialog"]'

/** Fields and editable regions that own every key press while focused. */
const TEXT_ENTRY_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * True when the event must not trigger a shortcut.
 *
 * A dialog blocks shortcuts even when the event target sits outside it. Several
 * dialogs are opened by a trigger that keeps focus - the export dialog is the
 * reachable case, because its trigger is rendered on the review route and the
 * reviewer shortcuts stay mounted underneath - and the state that opened a
 * dialog is not visible to every shortcut surface. Asking the document which
 * dialog is on top covers all of them at once.
 */
export function isShortcutBlocked(event: KeyboardEvent, root: Document = document): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true

  const target = event.target
  const insideTextEntry = target instanceof Element && Boolean(target.closest(TEXT_ENTRY_SELECTOR))
  if (insideTextEntry) return true

  // A shortcut listener on window still receives events from the dialog. Let
  // the dialog own those keys too, so a background action cannot stack a
  // second modal behind the one the learner is using.
  return root.querySelector(SHORTCUT_DIALOG_SELECTOR) !== null
}
