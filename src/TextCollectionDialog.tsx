import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { BASIC_NOTE_TYPE_ID, collection } from './collection'
import { applyTextImport, defaultMapping, exportTextCollection, pathsForDecks, previewTextImport, readTextDocument, serializeDelimited, TEXT_BYTE_LIMIT, type ColumnMapping, type CsvDocument, type Delimiter, type ImportOptions, type TextEncoding, type TextPreview } from './text-csv'

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function TextCollectionDialog({ onClose }: { onClose: () => void }) {
  const data = useLiveQuery(async () => ({ decks: await collection.decks.toArray(), types: await collection.noteTypes.toArray() }), [])
  const [tab, setTab] = useState<'import' | 'export'>('import')
  const [source, setSource] = useState<'file' | 'paste'>('file')
  const [bytes, setBytes] = useState<Uint8Array>()
  const [pasted, setPasted] = useState('')
  const [encoding, setEncoding] = useState<TextEncoding>('auto')
  const [delimiter, setDelimiter] = useState<Delimiter | 'auto'>('auto')
  const [quote, setQuote] = useState<'"' | "'" | ''>('"')
  const [header, setHeader] = useState(true)
  const [csv, setCsv] = useState<CsvDocument>()
  const [mapping, setMapping] = useState<ColumnMapping[]>([])
  const [options, setOptions] = useState<Omit<ImportOptions, 'mapping' | 'header'>>({ deckId: '', typeId: BASIC_NOTE_TYPE_ID, html: 'strip', duplicates: 'ignore', newRows: 'add', createDecks: false, replaceTags: true })
  const [preview, setPreview] = useState<TextPreview>()
  const [partial, setPartial] = useState(false)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const [exportMode, setExportMode] = useState<'notes' | 'cards'>('notes')
  const [exportDeck, setExportDeck] = useState('')
  const [exportFields, setExportFields] = useState<string[] | null>(null)
  const [exportMeta, setExportMeta] = useState({ tags: true, deck: true, type: true, identifiers: true })
  const [exportHtml, setExportHtml] = useState<'keep' | 'strip'>('keep')
  const [exportDelimiter, setExportDelimiter] = useState<Delimiter>(',')
  const [exportHeader, setExportHeader] = useState(true)
  const [bom, setBom] = useState(true)
  const fields = [...new Set((data?.types ?? []).flatMap((type) => type.fields.map((field) => field.name)))]
  const selectedFields = exportFields ?? fields
  const paths = pathsForDecks(data?.decks ?? [])
  const counts = preview?.rows.reduce((counts, row) => ({ ...counts, [row.action]: counts[row.action] + 1 }), { add: 0, update: 0, ignore: 0, error: 0 })
  const resetPreview = () => { setPreview(undefined); setResult(''); setError(''); setPage(0) }
  const changeOptions = (next: Partial<typeof options>) => { setOptions((previous) => ({ ...previous, ...next })); resetPreview() }
  const resetColumns = () => { setCsv(undefined); setMapping([]); resetPreview() }

  async function chooseFile(file?: File) {
    resetColumns(); setBytes(undefined)
    if (!file) return
    setBusy(true)
    try {
      if (file.size > TEXT_BYTE_LIMIT) throw new Error('Text files must be at most 16 MiB.')
      const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('Unable to read this file. Paste its text instead.')); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(file)
      })
      setBytes(new Uint8Array(buffer))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to read this file.') }
    finally { setBusy(false) }
  }

  async function readColumns() {
    resetColumns()
    try {
      const input = source === 'paste' ? new TextEncoder().encode(pasted) : bytes
      if (!input) throw new Error('Choose a file or paste text first.')
      const document = readTextDocument(input, source === 'paste' ? 'utf-8' : encoding, delimiter, quote)
      if (!document.rows.length) throw new Error('This text has no rows.')
      const type = data?.types.find((type) => type.id === options.typeId)
      if (!type) throw new Error('Select a note type.')
      setCsv(document); setMapping(defaultMapping(document, type, header))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to parse text.') }
  }

  async function previewRows() {
    if (!csv) return
    setBusy(true); resetPreview()
    try { setPreview(await previewTextImport(collection, csv, { ...options, mapping, header })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to preview this import.') }
    finally { setBusy(false) }
  }

  async function importRows() {
    if (!preview) return
    setBusy(true); setError('')
    try {
      const counts = await applyTextImport(collection, preview, partial)
      setResult(`Import complete: ${counts.added} added, ${counts.updated} updated, ${counts.ignored} ignored, ${counts.errors} invalid rows skipped.`)
      setPreview(undefined)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to import rows.') }
    finally { setBusy(false) }
  }

  async function exportRows() {
    setBusy(true); setError(''); setResult('')
    try {
      const output = await exportTextCollection(collection, { mode: exportMode, deckId: exportDeck || undefined, fields: selectedFields, ...exportMeta, html: exportHtml, header: exportHeader, delimiter: exportDelimiter, bom })
      downloadText(output.text, `kiroku-${exportMode}.${exportDelimiter === '\t' ? 'tsv' : 'csv'}`)
      setResult(`Text export ready: ${output.count} ${exportMode === 'notes' ? 'notes' : 'cards'}. UTF-8${bom ? ' with BOM' : ''}; save the download in Files.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to export text.') }
    finally { setBusy(false) }
  }

  return <div className="dialog-backdrop"><section className="dialog text-collection-dialog" role="dialog" aria-modal="true" aria-labelledby="text-collection-title">
    <button className="text-button" aria-label="Close text import/export" disabled={busy} onClick={onClose}>Close</button>
    <span className="section-code">COLLECTION // TEXT</span><h2 id="text-collection-title">Import and export text</h2>
    <div className="text-transfer-tabs"><button className="text-button" aria-pressed={tab === 'import'} disabled={busy} onClick={() => { setTab('import'); setError(''); setResult('') }}>Import text</button><button className="text-button" aria-pressed={tab === 'export'} disabled={busy} onClick={() => { setTab('export'); setError(''); setResult('') }}>Export text</button></div>
    <p>Text imports create or update notes and generate cards from existing note types. Card export includes identity/template information; scheduling, review logs and media bytes require Anki package export.</p>
    {tab === 'import' ? <>
      <fieldset disabled={busy} className="text-transfer-controls"><legend>Read CSV or tab-separated text</legend>
        <label>Text source<select value={source} onChange={(event) => { setSource(event.target.value as typeof source); resetColumns() }}><option value="file">File</option><option value="paste">Paste text</option></select></label>
        {source === 'file' ? <label>Text or CSV file<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(event) => void chooseFile(event.target.files?.[0])} /></label> : <label>Paste CSV or tab-separated text<textarea value={pasted} rows={6} onChange={(event) => { setPasted(event.target.value); resetColumns() }} /></label>}
        <label>Encoding<select value={encoding} disabled={source === 'paste'} onChange={(event) => { setEncoding(event.target.value as TextEncoding); resetColumns() }}><option value="auto">Detect BOM / UTF-8</option><option value="utf-8">UTF-8</option><option value="shift_jis">Shift JIS (Japanese)</option><option value="utf-16le">UTF-16 little endian</option><option value="utf-16be">UTF-16 big endian</option></select></label>
        <label>Delimiter<select value={delimiter} onChange={(event) => { setDelimiter(event.target.value as Delimiter | 'auto'); resetColumns() }}><option value="auto">Detect</option><option value=",">Comma</option><option value={'\t'}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></select></label>
        <label>Quoting<select value={quote} onChange={(event) => { setQuote(event.target.value as typeof quote); resetColumns() }}><option value={'"'}>Double quotes</option><option value="'">Single quotes</option><option value="">No quoting</option></select></label>
        <label className="export-option"><input type="checkbox" checked={header} onChange={(event) => { setHeader(event.target.checked); resetColumns() }} />First row contains headers</label>
        <label>Default note type<select value={options.typeId} onChange={(event) => { changeOptions({ typeId: event.target.value }); resetColumns() }}>{data?.types.filter((type) => type.kind !== 'image-occlusion').map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
        <button className="text-button" type="button" onClick={() => void readColumns()}>Read columns</button>
      </fieldset>
      {csv && <fieldset disabled={busy} className="text-transfer-controls"><legend>Map columns and choose import policy</legend>
        <p>{csv.rows.length - Number(header)} data rows · {csv.encoding} · delimiter {csv.delimiter === '\t' ? 'Tab' : csv.delimiter}</p>
        <div className="text-column-mapping">{mapping.map((role, index) => <label key={index}>Column {index + 1}{header ? ` · ${csv.rows[0].values[index]}` : ''}<select aria-label={`Map column ${index + 1}`} value={role} onChange={(event) => { setMapping((previous) => previous.map((value, column) => column === index ? event.target.value as ColumnMapping : value)); resetPreview() }}><option value="ignore">Ignore column</option><option value="identifier">Stable note identifier</option><option value="deck">Deck path or ID</option><option value="type">Note type name or ID</option><option value="tags">Tags</option>{fields.map((field) => <option key={field} value={`field:${field}`}>Field: {field}</option>)}</select></label>)}</div>
        <label>Default destination deck<select value={options.deckId} onChange={(event) => changeOptions({ deckId: event.target.value })}><option value="">Choose a deck or map its column</option>{data?.decks.map((deck) => <option key={deck.id} value={deck.id}>{paths.get(deck.id)}</option>)}</select></label>
        <label className="export-option"><input type="checkbox" checked={options.createDecks} onChange={(event) => changeOptions({ createDecks: event.target.checked })} />Create missing mapped deck paths</label>
        <label>Existing matching notes<select value={options.duplicates} onChange={(event) => changeOptions({ duplicates: event.target.value as typeof options.duplicates })}><option value="ignore">Ignore matches</option><option value="update">Update matches</option><option value="duplicate">Add intentional duplicates</option><option value="error">Report duplicates as errors</option></select></label>
        <label>New notes<select value={options.newRows} onChange={(event) => changeOptions({ newRows: event.target.value as typeof options.newRows })}><option value="add">Add new notes</option><option value="ignore">Ignore new notes</option></select></label>
        <label>HTML handling<select value={options.html} onChange={(event) => changeOptions({ html: event.target.value as typeof options.html })}><option value="strip">Convert HTML to plain text</option><option value="keep">Keep markup as literal text</option></select></label>
        <label className="export-option"><input type="checkbox" checked={options.replaceTags} onChange={(event) => changeOptions({ replaceTags: event.target.checked })} />Replace existing tags from the mapped tags column</label>
        <p>Stable identifiers match first. Without one, matching uses note type, deck and first field. Tags accept a JSON string array or whitespace-separated names. Preview never changes the collection.</p>
        <button className="text-button" onClick={() => void previewRows()}>Preview import</button>
      </fieldset>}
      {preview && counts && <div className="text-import-preview">
        <h3>Import preview</h3><p role="status">{counts.add} to add · {counts.update} to update · {counts.ignore} to ignore · {counts.error} invalid</p>
        {preview.newDecks.length > 0 && <p>New deck paths: {preview.newDecks.join(', ')}</p>}
        <div className="text-preview-scroll"><table><thead><tr><th>Line</th><th>Action</th><th>Values and affected note</th></tr></thead><tbody>{preview.rows.slice(page * 25, (page + 1) * 25).map((row) => <tr key={row.line}><td>{row.line}</td><td>{row.action}</td><td><p>{row.message}</p><details><summary>{Object.values(row.fields ?? {}).join(' · ').slice(0, 180) || row.original.join(' · ').slice(0, 180)}</summary><p>Note: {row.existing?.id ?? row.noteId ?? 'new identity'} · Deck: {row.deckPath} · Tags: {row.tags?.join(', ')}</p>{row.existing && <p>Previous values: {Object.values(row.existing.fields).join(' · ')}</p>}<pre>{JSON.stringify(row.fields ?? row.original, null, 2)}</pre></details></td></tr>)}</tbody></table></div>
        <div className="text-transfer-tabs"><button className="text-button" disabled={page === 0 || busy} onClick={() => setPage((value) => value - 1)}>Previous preview page</button><span>Rows {page * 25 + 1}–{Math.min((page + 1) * 25, preview.rows.length)} of {preview.rows.length}</span><button className="text-button" disabled={(page + 1) * 25 >= preview.rows.length || busy} onClick={() => setPage((value) => value + 1)}>Next preview page</button></div>
        {counts.error > 0 && <><button className="text-button" disabled={busy} onClick={() => downloadText(serializeDelimited([['Line', 'Error', 'Original values'], ...preview.rows.filter((row) => row.action === 'error').map((row) => [String(row.line), row.message, JSON.stringify(row.original)])]), 'kiroku-import-errors.csv')}>Download row errors</button><label className="export-option"><input type="checkbox" checked={partial} disabled={busy} onChange={(event) => setPartial(event.target.checked)} />Import valid rows and skip invalid rows</label></>}
        <button className="primary-action" disabled={busy || counts.add + counts.update === 0 || counts.error > 0 && !partial} onClick={() => void importRows()}>Import {counts.add + counts.update} valid rows</button>
      </div>}
    </> : <fieldset disabled={busy} className="text-transfer-controls"><legend>Export notes or cards</legend>
      <label>Export rows<select value={exportMode} onChange={(event) => setExportMode(event.target.value as typeof exportMode)}><option value="notes">One row per note</option><option value="cards">One row per card</option></select></label>
      <label>Text export scope<select value={exportDeck} onChange={(event) => setExportDeck(event.target.value)}><option value="">Whole collection</option>{data?.decks.map((deck) => <option key={deck.id} value={deck.id}>{paths.get(deck.id)}</option>)}</select></label>
      <fieldset><legend>Fields to export</legend>{fields.map((field) => <label key={field} className="export-option"><input type="checkbox" checked={selectedFields.includes(field)} onChange={(event) => setExportFields(event.target.checked ? [...selectedFields, field] : selectedFields.filter((name) => name !== field))} />{field}</label>)}</fieldset>
      {(['tags', 'deck', 'type', 'identifiers'] as const).map((key) => <label className="export-option" key={key}><input type="checkbox" checked={exportMeta[key]} onChange={(event) => setExportMeta((previous) => ({ ...previous, [key]: event.target.checked }))} />Include {key === 'identifiers' ? 'stable note identifiers' : key === 'type' ? 'note type' : key}</label>)}
      <label>Export HTML handling<select value={exportHtml} onChange={(event) => setExportHtml(event.target.value as typeof exportHtml)}><option value="keep">Keep original field text and markup</option><option value="strip">Convert HTML to plain text</option></select></label>
      <label>Text export delimiter<select value={exportDelimiter} onChange={(event) => setExportDelimiter(event.target.value as Delimiter)}><option value=",">Comma</option><option value={'\t'}>Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option></select></label>
      <label className="export-option"><input type="checkbox" checked={exportHeader} onChange={(event) => setExportHeader(event.target.checked)} />Include column headers</label>
      <label className="export-option"><input type="checkbox" checked={bom} onChange={(event) => setBom(event.target.checked)} />Include UTF-8 BOM for Windows spreadsheet tools</label>
      <button className="primary-action" onClick={() => void exportRows()}>Download text export</button>
    </fieldset>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {result && <p role="status">{result}</p>}
    {busy && <p role="status">Working…</p>}
  </section></div>
}
