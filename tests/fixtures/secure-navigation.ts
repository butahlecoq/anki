import { Deck, Note, Notetype, Package } from 'ankipack'
import type { SqlJsStatic } from 'sql.js'
export const navigationFront = '<b>{{Word}}</b>{{Media}}<p><a href="https://example.org/dictionary?term={{Word}}" target="_top">Dictionary</a></p><p><a href="{{Link}}">Reading source</a></p>'
export const navigationPNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL4+QAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
export async function navigationPackage(SQL: SqlJsStatic, front = navigationFront, css = '') {
  const type = new Notetype({ id: 1700000000067, name: 'Japanese navigation', fields: ['Word', 'Meaning', 'Media', 'Link'].map(name => ({ name })), templates: [{ name: 'Recognition', questionFormat: front, answerFormat: '{{FrontSide}}<hr>{{Meaning}}' }], css })
  const deck = new Deck({ id: 1700000000167, name: '日本語 links' })
  deck.addNote(new Note({ notetype: type, guid: 'synthetic-navigation-note', fields: ['猫', 'cat · ねこ', '<img src="cat.png">', 'https://example.org/reading?q=日本語'], tags: ['synthetic'] }))
  const pkg = new Package(); pkg.addDeck(deck); pkg.addMedia('cat.png', navigationPNG)
  return pkg.toUint8Array(SQL)
}
