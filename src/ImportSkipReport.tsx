import type { AnkiImportSkippedNote } from './anki-import.js'

export function ImportSkipReport({ skipped }: { skipped: readonly AnkiImportSkippedNote[] }) {
  const rows = skipped ?? []
  if (!rows.length) return null
  const cards = rows.reduce((count, note) => count + note.cardIds.length, 0)
  const reviews = rows.reduce((count, note) => count + note.reviewIds.length, 0)
  const media = new Set(rows.flatMap((note) => note.mediaNames)).size
  return <section className="import-report import-skipped" aria-label="Skipped import rows">
    <h3>Notes omitted from this collection</h3>
    <p>{rows.length} notes, {cards} cards, {reviews} reviews, and {media} referenced media names are omitted under this import choice.</p>
    <ul>{rows.map((note) => <li key={note.guid}>
      <strong>{note.guid} · {note.noteType}</strong>
      <span>Native note {note.ankiNoteId}; cards {note.cardIds.join(', ') || 'none'}; reviews {note.reviewIds.join(', ') || 'none'}; media {note.mediaNames.join(', ') || 'none'}.</span>
      {note.reasons.map((reason) => <span key={reason}>{reason}</span>)}
    </li>)}</ul>
  </section>
}
