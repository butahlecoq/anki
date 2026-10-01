import { describe, expect, test } from 'vitest'
import { clozeOrdinals, renderTemplate, tryRenderTemplate, validateTemplate } from './template-renderer'

describe('renderTemplate', () => {
  test('masks only the active cloze ordinal, using hints and one card for repeated ordinals', () => {
    const fields = { Text: '{{c1::東京::city}}と{{c2::大阪}}へ{{c1::行く}}' }
    expect(clozeOrdinals(fields.Text)).toEqual([1, 2])
    expect(renderTemplate('{{cloze:Text}}', fields, undefined, { kind: 'cloze', ordinal: 1, side: 'front' }).html)
      .toBe('<span class="cloze">[city]</span>と大阪へ<span class="cloze">[…]</span>')
    expect(renderTemplate('{{cloze:Text}}', fields, undefined, { kind: 'cloze', ordinal: 2, side: 'front' }).html)
      .toBe('東京と<span class="cloze">[…]</span>へ行く')
    expect(renderTemplate('{{cloze:Text}}', fields, undefined, { kind: 'cloze', ordinal: 1, side: 'back' }).html)
      .toBe('<span class="cloze">東京</span>と大阪へ<span class="cloze">行く</span>')
  })

  test('renders Japanese reading filters while escaping field text', () => {
    const fields = { Reading: '世[よ]の 中[なか] <img>[x]' }
    expect(renderTemplate('{{furigana:Reading}}', fields).html)
      .toBe('<ruby>世<rt>よ</rt></ruby>の <ruby>中<rt>なか</rt></ruby> &lt;img&gt;[x]')
    expect(renderTemplate('{{kana:Reading}}', fields).html).toBe('よの なか &lt;img&gt;[x]')
    expect(renderTemplate('{{kanji:Reading}}', fields).html).toBe('世の 中 &lt;img&gt;[x]')
    expect(renderTemplate('{{text:Reading}}', fields).html).toBe('世[よ]の 中[なか] &lt;img&gt;[x]')
    const adjacent = { Reading: '私[わたし]は猫[ねこ]と食べる[たべる]' }
    expect(renderTemplate('{{furigana:Reading}}', adjacent).html)
      .toBe('<ruby>私<rt>わたし</rt></ruby>は<ruby>猫<rt>ねこ</rt></ruby>と<ruby>食べる<rt>たべる</rt></ruby>')
    expect(renderTemplate('{{kana:Reading}}', adjacent).html).toBe('わたしはねことたべる')
    expect(renderTemplate('{{kanji:Reading}}', adjacent).html).toBe('私は猫と食べる')
  })

  test('provides typed-answer metadata without rendering an input in the sandbox', () => {
    expect(renderTemplate('Say {{type:Word}}', { Word: '猫' })).toMatchObject({ html: 'Say ', typedAnswer: '猫' })
    expect(renderTemplate('{{type:Word}}', { Word: '猫' })).toEqual({ html: '', isEmpty: false, typedAnswer: '猫' })
    expect(renderTemplate('{{type:Word}}', { Word: ' ' }).isEmpty).toBe(true)
    expect(renderTemplate('{{type:cloze:Text}}', { Text: '{{c1::猫::animal}}' }, undefined, { kind: 'cloze', ordinal: 1, side: 'front' }))
      .toMatchObject({ typedAnswer: '猫' })
  })

  test('keeps an exact legacy field name with a colon as a field, not a filter', () => {
    expect(() => validateTemplate('{{type:Word}}', ['type:Word', 'Word'], 'front')).not.toThrow()
    expect(renderTemplate('{{type:Word}}', { 'type:Word': 'legacy value', Word: 'typed value' }))
      .toEqual({ html: 'legacy value', isEmpty: false })
    expect(renderTemplate('{{reverse:Word}}', { 'reverse:Word': '<b>literal</b>' }))
      .toEqual({ html: '&lt;b&gt;literal&lt;/b&gt;', isEmpty: false })
  })

  test('rejects unsupported filters and malformed clozes through a safe result', () => {
    expect(() => validateTemplate('{{reverse:Word}}', ['Word'], 'front')).toThrow(/Unsupported template filter: reverse/)
    expect(() => validateTemplate('{{type:nc:Word}}', ['Word'], 'front')).toThrow(/Unsupported template filter: type:nc/)
    expect(() => clozeOrdinals('{{c1::missing')).toThrow(/Unclosed cloze deletion/)
    expect(tryRenderTemplate('{{cloze:Text}}', { Text: '{{c0::zero}}' }, undefined, { kind: 'cloze', ordinal: 1, side: 'front' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/ordinal/i) })
    expect(tryRenderTemplate('{{Missing', { Word: '猫' })).toMatchObject({ ok: false, error: expect.stringMatching(/delimiter/i) })
  })

  test('applies cloze ordinal conditionals and refuses nested deletions', () => {
    const fields = { Text: '{{c1::東京}}' }
    expect(renderTemplate('{{#c1}}first{{/c1}}{{^c2}} not second{{/c2}}{{cloze:Text}}', fields, undefined, { kind: 'cloze', ordinal: 1 }).html)
      .toBe('first not second<span class="cloze">[…]</span>')
    expect(() => clozeOrdinals('{{c1::outer {{c2::inner}}}}')).toThrow(/Malformed cloze deletion/)
    expect(() => clozeOrdinals('{{c1::foo::hint {{c2::bar}}}}')).toThrow(/Malformed cloze deletion/)
    expect(() => clozeOrdinals('{{c1::foo::hint {{nested}}}}')).toThrow(/Malformed cloze deletion/)
  })

  test('renders cloze answers on the back when FrontSide is supplied', () => {
    const fields = { Text: '{{c1::猫}}' }
    expect(tryRenderTemplate('{{FrontSide}}<hr>{{cloze:Text}}', fields, '<span class="cloze">[…]</span>', { kind: 'cloze', ordinal: 1 }))
      .toMatchObject({ ok: true, value: { html: '<span class="cloze">[…]</span><hr><span class="cloze">猫</span>' } })
  })
  test('escapes field values while retaining template markup', () => {
    expect(renderTemplate('<b>{{Word}}</b>', { Word: '<img src=x onerror=alert(1)>&"' })).toEqual({
      html: '<b>&lt;img src=x onerror=alert(1)&gt;&amp;&quot;</b>',
      isEmpty: false,
    })
  })

  test('renders positive and inverse sections from trimmed field values', () => {
    expect(renderTemplate('{{#Hint}}<i>{{Hint}}</i>{{/Hint}}{{^Answer}}missing{{/Answer}}', { Hint: '  clue  ', Answer: ' ' }).html)
      .toBe('<i>  clue  </i>missing')
  })

  test('inserts rendered front markup on the back', () => {
    expect(renderTemplate('<hr>{{FrontSide}}', {}, '<b>&lt;front&gt;</b>').html)
      .toBe('<hr><b>&lt;front&gt;</b>')
  })

  test('detects a front with no visible field content', () => {
    expect(renderTemplate('<div>{{Missing}}</div>', {}).isEmpty).toBe(true)
    expect(renderTemplate('<b>label</b>', {}).isEmpty).toBe(true)
    expect(renderTemplate('<div>{{Word}}</div>', { Word: '猫' }).isEmpty).toBe(false)
  })

  test('rejects nested conditionals', () => {
    expect(() => renderTemplate('{{#A}}{{#B}}{{B}}{{/B}}{{/A}}', { A: 'a', B: 'b' }))
      .toThrow(/nested/i)
  })

  test('rejects unknown field tokens and conditionals', () => {
    expect(() => validateTemplate('{{Unknown}}', ['Known'], 'front')).toThrow(/unknown field/i)
    expect(() => validateTemplate('{{#Unknown}}{{Known}}{{/Unknown}}', ['Known'], 'back')).toThrow(/unknown field/i)
  })

  test('allows FrontSide on the back but rejects it on the front', () => {
    expect(() => validateTemplate('{{FrontSide}}', ['Known'], 'front')).toThrow(/FrontSide.*front/i)
    expect(() => validateTemplate('{{FrontSide}}<hr>{{Known}}', ['Known'], 'back')).not.toThrow()
  })

  test('rejects unmatched opening or closing template delimiters', () => {
    expect(() => validateTemplate('before {{Word', ['Word'], 'front')).toThrow(/unmatched.*delimiter/i)
    expect(() => validateTemplate('{{Word}} after }}', ['Word'], 'front')).toThrow(/unmatched.*delimiter/i)
  })
})
