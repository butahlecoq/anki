import { fieldChangePreview, type FieldOperation } from './browser-maintenance'
import type { Note, NoteType } from './collection'

self.onmessage = (event: MessageEvent<{ notes: Note[]; types: NoteType[]; operation: FieldOperation }>) => {
  try { self.postMessage({ changes: fieldChangePreview(event.data.notes, event.data.types, event.data.operation) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Unable to preview these fields.' }) }
}
