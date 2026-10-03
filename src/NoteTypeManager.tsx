import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { collection, type NoteType, type NoteTypeField } from './collection'
import { TemplatePreview } from './TemplatePreview'
import { clozeOrdinals } from './template-renderer'
import { fieldsByName, renderCard } from './card-rendering'
import { useDialogKeyboard } from './use-dialog-keyboard'

type DraftField = { key: string; id?: string; name: string }
type DraftTemplate = { key: string; id?: string; name: string; front: string; back: string; css: string }

function TypeEditor({ noteType, onClose }: { noteType?: NoteType; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const [name, setName] = useState(noteType?.name ?? '')
  const [kind, setKind] = useState<Exclude<NoteType['kind'], 'image-occlusion'>>(noteType?.kind === 'cloze' ? 'cloze' : 'standard')
  const [fields, setFields] = useState<DraftField[]>(() => noteType?.fields.map((field) => ({ ...field, key: field.id })) ?? [
    { key: crypto.randomUUID(), name: 'Front' }, { key: crypto.randomUUID(), name: 'Back' },
  ])
  const [templates, setTemplates] = useState<DraftTemplate[]>(() => noteType?.templates.map((template) => ({ ...template, key: template.id })) ?? [
    { key: crypto.randomUUID(), name: 'Card 1', front: '{{Front}}', back: '{{Back}}', css: '' },
  ])
  const [removedFields, setRemovedFields] = useState<Record<string, 'discard' | 'keep-as-extra'>>({})
  const [removed, setRemoved] = useState<NoteTypeField[]>([])
  const [previewTemplate, setPreviewTemplate] = useState(0)
  const [previewSide, setPreviewSide] = useState<'front' | 'back'>('front')
  const [previewOrdinal, setPreviewOrdinal] = useState(1)
  const [sampleOverrides, setSampleOverrides] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const exampleNote = useLiveQuery(() => noteType ? collection.notes.where('typeId').equals(noteType.id).first() : undefined, [noteType?.id])

  function moveField(index: number, delta: number) {
    const next = [...fields]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setFields(next)
  }

  function removeField(index: number) {
    const field = fields[index]
    if (field.id) setRemoved((current) => [...current, field as NoteTypeField])
    setFields((current) => current.filter((_, position) => position !== index))
  }

  function changeKind(next: Exclude<NoteType['kind'], 'image-occlusion'>) {
    setKind(next)
    setPreviewTemplate(0)
    setPreviewOrdinal(1)
    setSampleOverrides({})
    if (next === 'cloze') {
      setFields([{ key: crypto.randomUUID(), name: 'Text' }, { key: crypto.randomUUID(), name: 'Extra' }])
      setTemplates([{ key: crypto.randomUUID(), name: 'Deletion', front: '{{cloze:Text}}', back: '{{cloze:Text}}<hr>{{Extra}}', css: '' }])
    } else {
      setFields([{ key: crypto.randomUUID(), name: 'Front' }, { key: crypto.randomUUID(), name: 'Back' }])
      setTemplates([{ key: crypto.randomUUID(), name: 'Card 1', front: '{{Front}}', back: '{{Back}}', css: '' }])
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      if (removed.some((field) => !removedFields[field.id])) throw new Error('Choose how to handle each removed field')
      if (noteType) {
        await collection.updateNoteType(noteType.id, {
          name,
          fields: fields.map(({ id, name }) => ({ id, name })),
          templates: templates.map(({ id, name, front, back, css }) => ({ id, name, front, back, css })),
          removedFields,
        })
      } else {
        await collection.createNoteType({ name, kind, fields: fields.map(({ name }) => ({ name })), templates: templates.map(({ name, front, back, css }) => ({ name, front, back, css })) })
      }
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save note type')
    }
  }

  const selected = templates[previewTemplate] ?? templates[0]
  const clozeFieldName = templates[0]?.front.match(/{{\s*cloze:([^{}:]+?)\s*}}/)?.[1].trim()
  const sampleFieldsById = Object.fromEntries(fields.map((field) => [field.id ?? field.key, sampleOverrides[field.id ?? field.key] ?? exampleNote?.fields[field.id ?? field.key] ?? (kind === 'cloze' && field.name === clozeFieldName ? '{{c1::東京::city}}に{{c2::行く}}' : '')]))
  const displayFields = fieldsByName(fields.map((field) => ({ id: field.id ?? field.key, name: field.name })), sampleFieldsById)
  let previewOrdinals: number[] = []
  if (kind === 'cloze') {
    try { previewOrdinals = clozeOrdinals(displayFields[clozeFieldName ?? ''] ?? '') }
    catch { /* The preview reports the malformed sample. */ }
  }
  const shownOrdinal = previewOrdinals.includes(previewOrdinal) ? previewOrdinal : previewOrdinals[0]
  const rendering = selected ? renderCard(selected, displayFields, { kind, ordinal: shownOrdinal }) : undefined

  return (
    <div className="dialog-backdrop">
      <section {...dialogKeyboard} className="dialog type-dialog" role="dialog" aria-modal="true" aria-labelledby="type-dialog-title">
        <span className="section-code">NOTE TYPE // {noteType ? 'EDIT' : 'NEW'}</span>
        <h2 id="type-dialog-title">{noteType ? `Edit ${noteType.name}` : 'Create note type'}</h2>
        <form onSubmit={(event) => void save(event)}>
          <label>Note type name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Card generation<select value={kind} disabled={Boolean(noteType)} onChange={(event) => changeKind(event.target.value as Exclude<NoteType['kind'], 'image-occlusion'>)}><option value="standard">Standard</option><option value="cloze">Cloze deletions</option></select></label>
          <section className="editor-section" aria-label="Fields">
            <h3>Fields</h3>
            {fields.map((field, index) => (
              <div className="editor-row" key={field.key}>
                <label>Field {index + 1} name<input value={field.name} onChange={(event) => setFields((current) => current.map((item) => item.key === field.key ? { ...item, name: event.target.value } : item))} /></label>
                <div className="editor-row-actions">
                  <button className="text-button" type="button" aria-label={`Move ${field.name} up`} disabled={index === 0} onClick={() => moveField(index, -1)}>↑</button>
                  <button className="text-button" type="button" aria-label={`Move ${field.name} down`} disabled={index === fields.length - 1} onClick={() => moveField(index, 1)}>↓</button>
                  <button className="text-button" type="button" aria-label={`Remove ${field.name}`} disabled={fields.length === 1} onClick={() => removeField(index)}>Remove</button>
                </div>
              </div>
            ))}
            {removed.map((field) => <label key={field.id}>Removed {field.name}
              <select value={removedFields[field.id] ?? ''} onChange={(event) => setRemovedFields((current) => ({ ...current, [field.id]: event.target.value as 'discard' | 'keep-as-extra' }))}>
                <option value="">Choose what happens to saved values</option>
                <option value="keep-as-extra">Keep as retired data</option>
                <option value="discard">Discard saved values</option>
              </select>
            </label>)}
            <button className="text-button" type="button" onClick={() => setFields((current) => [...current, { key: crypto.randomUUID(), name: '' }])}>Add field</button>
          </section>
          <section className="editor-section" aria-label="Card templates">
            <h3>Card templates</h3>
            {templates.map((template, index) => (
              <div className="template-fields" key={template.key}>
                <label>Template {index + 1} name<input value={template.name} onChange={(event) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, name: event.target.value } : item))} /></label>
                <label>Template {index + 1} front<textarea rows={3} value={template.front} onChange={(event) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, front: event.target.value } : item))} /></label>
                <label>Template {index + 1} back<textarea rows={3} value={template.back} onChange={(event) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, back: event.target.value } : item))} /></label>
                <label>Template {index + 1} CSS<textarea rows={3} value={template.css} onChange={(event) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, css: event.target.value } : item))} /></label>
                {templates.length > 1 && <button className="text-button" type="button" onClick={() => { setTemplates((current) => current.filter((item) => item.key !== template.key)); setPreviewTemplate(0) }}>Remove template</button>}
              </div>
            ))}
            {kind === 'standard' && <button className="text-button" type="button" onClick={() => setTemplates((current) => [...current, { key: crypto.randomUUID(), name: `Card ${current.length + 1}`, front: '', back: '', css: '' }])}>Add template</button>}
          </section>
          <section className="editor-section" aria-label="Card preview settings">
            <h3>Preview</h3>
            <div className="preview-controls">
              <label>Preview template<select value={previewTemplate} onChange={(event) => setPreviewTemplate(Number(event.target.value))}>{templates.map((template, index) => <option value={index} key={template.key}>{template.name || `Template ${index + 1}`}</option>)}</select></label>
              <label>Preview side<select value={previewSide} onChange={(event) => setPreviewSide(event.target.value as 'front' | 'back')}><option value="front">Front</option><option value="back">Back</option></select></label>
              {kind === 'cloze' && <label>Preview ordinal<select value={shownOrdinal ?? ''} onChange={(event) => setPreviewOrdinal(Number(event.target.value))}>{previewOrdinals.map((ordinal) => <option value={ordinal} key={ordinal}>c{ordinal}</option>)}</select></label>}
            </div>
            <div className="preview-samples">{fields.map((field) => <label key={field.key}>Sample {field.name || 'field'}<input value={displayFields[field.name] ?? ''} onChange={(event) => setSampleOverrides((current) => ({ ...current, [field.id ?? field.key]: event.target.value }))} /></label>)}</div>
            {rendering && <TemplatePreview rendering={rendering} templateOrdinal={previewTemplate + 1} side={previewSide} />}
          </section>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit">{noteType ? 'Save changes' : 'Save note type'}</button></div>
        </form>
      </section>
    </div>
  )
}

function DeleteTypeDialog({ noteType, types, onClose }: { noteType: NoteType; types: NoteType[]; onClose: () => void }) {
  const dialogKeyboard = useDialogKeyboard(onClose)
  const count = useLiveQuery(() => collection.notes.where('typeId').equals(noteType.id).count(), [noteType.id])
  const [replacementId, setReplacementId] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const replacement = types.find((type) => type.id === replacementId)

  async function remove(event: FormEvent) {
    event.preventDefault()
    try {
      if (count && !replacement) throw new Error('Choose a replacement note type')
      await collection.deleteNoteType(noteType.id, count ? { replacementTypeId: replacementId, fieldMapping: mapping } : undefined)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete note type')
    }
  }

  return <div className="dialog-backdrop"><section {...dialogKeyboard} className="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-type-title">
    <h2 id="delete-type-title">Delete {noteType.name}?</h2>
    <form onSubmit={(event) => void remove(event)}>
      {count === undefined ? <p>Checking saved notes…</p> : count > 0 ? <>
        <p>{count} saved {count === 1 ? 'note uses' : 'notes use'} this type. Choose a replacement and map each field. Unmapped values remain as retired data.</p>
        <label>Replacement note type<select value={replacementId} onChange={(event) => { setReplacementId(event.target.value); setMapping({}) }}><option value="">Choose a type</option>{types.filter((type) => type.id !== noteType.id).map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</select></label>
        {replacement && noteType.fields.map((field) => <label key={field.id}>Map {field.name}<select value={mapping[field.id] ?? ''} onChange={(event) => setMapping((current) => ({ ...current, [field.id]: event.target.value }))}><option value="">Keep as retired data</option>{replacement.fields.filter((target) => !Object.entries(mapping).some(([sourceId, targetId]) => sourceId !== field.id && targetId === target.id)).map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label>)}
      </> : <p>This type has no saved notes.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="text-button" type="button" data-dialog-initial-focus onClick={onClose}>Cancel</button><button className="text-button danger" type="submit" disabled={count === undefined}>Delete note type</button></div>
    </form>
  </section></div>
}

export function NoteTypeManager({ onNewDeck }: { onNewDeck: () => void }) {
  const types = useLiveQuery(() => collection.noteTypes.orderBy('name').toArray(), [], [])
  const [editor, setEditor] = useState<NoteType | 'new' | null>(null)
  const [deleting, setDeleting] = useState<NoteType | null>(null)
  const [error, setError] = useState('')

  async function clone(type: NoteType) {
    try { await collection.cloneNoteType(type.id) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to clone note type') }
  }

  return <>
    <section className="compact-hero"><div><span className="section-code">NOTE TYPES // COLLECTION</span><h1>Shape what you <em>remember</em></h1><p>Define fields and card templates for every kind of note.</p></div><div className="type-actions"><button className="text-button" type="button" onClick={onNewDeck}>New deck</button><button className="primary-action" type="button" onClick={() => setEditor('new')}>Create note type</button></div></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="type-list" aria-label="Note types">{types.map((type) => <article className="type-tile" key={type.id}><span className="section-code">{type.fields.length} FIELDS // {type.templates.length} TEMPLATES</span><h2>{type.name}</h2><p>{type.fields.map((field) => field.name).join(' · ')}</p><div className="type-actions">{!type.protected && <button className="text-button" type="button" aria-label={`Edit ${type.name}`} onClick={() => setEditor(type)}>Edit</button>}<button className="text-button" type="button" aria-label={`Clone ${type.name}`} onClick={() => void clone(type)}>Clone</button>{!type.protected && <button className="text-button danger" type="button" aria-label={`Delete ${type.name}`} onClick={() => setDeleting(type)}>Delete</button>}</div></article>)}</section>
    {editor && <TypeEditor noteType={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />}
    {deleting && <DeleteTypeDialog noteType={deleting} types={types} onClose={() => setDeleting(null)} />}
  </>
}
