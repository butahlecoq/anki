import { collection } from './collection'

export const SAMPLE_DECK_NAME = 'Sample — Japanese Starter'
const SAMPLE_NOTE_TYPE_NAME = 'Sample Japanese Cloze'

const sampleNotes = [
  {
    context: '猫[ねこ]は',
    cloze: '{{c1::魚}}を食べます。',
    meaning: 'The cat eats fish.',
  },
  {
    context: '犬[いぬ]は',
    cloze: '{{c1::庭}}で遊びます。',
    meaning: 'The dog plays in the garden.',
  },
]

async function fixtureFile(name: string, type: string) {
  const response = await fetch(`/sample-deck/${name}`)
  if (!response.ok) throw new Error(`Unable to load the sample ${name} attachment.`)
  return new File([await response.blob()], name, { type })
}

export async function loadSampleDeck() {
  if (await collection.decks.where('name').equals(SAMPLE_DECK_NAME).count()) return

  const [audio, image] = await Promise.all([
    fixtureFile('cat.wav', 'audio/wav'),
    fixtureFile('garden.png', 'image/png'),
  ])
  let deckId: string | undefined
  let noteTypeId: string | undefined
  try {
    const noteType = await collection.createNoteType({
      name: SAMPLE_NOTE_TYPE_NAME,
      kind: 'cloze',
      fields: [{ name: 'Context' }, { name: 'Cloze text' }, { name: 'Meaning' }],
      templates: [{
        name: 'Japanese sentence',
        front: '{{furigana:Context}}<br>{{cloze:Cloze text}}',
        back: '{{furigana:Context}}<br>{{cloze:Cloze text}}<hr>{{Meaning}}',
        css: '',
      }],
    })
    noteTypeId = noteType.id
    const deck = await collection.createDeck(SAMPLE_DECK_NAME)
    deckId = deck.id
    const contextField = noteType.fields.find((field) => field.name === 'Context')!
    const clozeField = noteType.fields.find((field) => field.name === 'Cloze text')!
    const meaningField = noteType.fields.find((field) => field.name === 'Meaning')!
    for (const [index, sample] of sampleNotes.entries()) {
      const note = await collection.createNote(deck.id, noteType.id, {
        [contextField.id]: sample.context,
        [clozeField.id]: sample.cloze,
        [meaningField.id]: sample.meaning,
      })
      if (index === 0) {
        await collection.attachMedia(note.id, { file: audio, side: 'front', playback: 'manual' })
        await collection.attachMedia(note.id, { file: image, side: 'front' })
      }
    }
  } catch (error) {
    if (deckId) await collection.deleteDeck(deckId, { mode: 'delete-subtree' })
    if (noteTypeId && await collection.notes.where('typeId').equals(noteTypeId).count() === 0) {
      await collection.deleteNoteType(noteTypeId).catch(() => undefined)
    }
    throw error
  }
}

export async function removeSampleDeck(deckId: string) {
  await collection.deleteDeck(deckId, { mode: 'delete-subtree' })
  const noteType = await collection.noteTypes.where('name').equals(SAMPLE_NOTE_TYPE_NAME).first()
  if (noteType && await collection.notes.where('typeId').equals(noteType.id).count() === 0) {
    await collection.deleteNoteType(noteType.id).catch(() => undefined)
  }
}
