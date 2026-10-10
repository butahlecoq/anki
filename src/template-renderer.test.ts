import { describe, expect, test } from 'vitest'
import { clozeOrdinals, renderTemplate, templateMediaFields, tryRenderTemplate, validateTemplate } from './template-renderer'
import { sanitizeFieldHtml } from './field-html'

describe('renderTemplate', () => {
  test('empty filter separators retain Anki cloze question and answer behavior', () => {
    const fields = { Question: 'A {{c1::synthetic answer::hint}} B' }
    expect(() => validateTemplate('{{cloze::Question}}', ['Question'], 'front', 'cloze')).not.toThrow()
    expect(renderTemplate('{{cloze::Question}}', fields, undefined, { kind: 'cloze', ordinal: 1, side: 'front' }).html)
      .toBe('A <span class="cloze">[hint]</span> B')
    expect(renderTemplate('{{cloze::Question}}', fields, undefined, { kind: 'cloze', ordinal: 1, side: 'back' }).html)
      .toBe('A <span class="cloze">synthetic answer</span> B')
    expect(tryRenderTemplate('{{cloze:unknown:Question}}', fields, undefined, { kind: 'cloze', ordinal: 1 }).ok).toBe(false)
  })
  test('hint fields use an accessible checkbox disclosure without executing field markup', () => {
    const result = renderTemplate('{{Word}} {{hint:Meaning}}', { Word: '猫', Meaning: '<script>alert(1)</script>cat' })
    const body = new DOMParser().parseFromString(result.html, 'text/html').body
    expect(body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(body.querySelector('label')?.textContent).toBe('Show Meaning')
    expect(body.querySelector('.card-hint-content')?.textContent).toBe('<script>alert(1)</script>cat')
    expect(body.querySelector('label')?.getAttribute('for')).toBe(body.querySelector('input')?.id)
    expect(body.querySelector('script')).toBeNull()
    expect(result.isEmpty).toBe(false)
    expect(renderTemplate('{{hint:Meaning}}', { Meaning: ' ' }).isEmpty).toBe(true)
    expect(renderTemplate('{{hint:Meaning}}', { Meaning: ' ' }).html).toBe('')
    expect(tryRenderTemplate('{{hint:furigana:Word}}', { Word: '猫[ねこ]' }).ok).toBe(false)
  })
  test('hint controls have independent stable ids', () => {
    const body = new DOMParser().parseFromString(renderTemplate('{{hint:First}} {{hint:Second}}', { First: 'one', Second: 'two' }).html, 'text/html').body
    expect([...body.querySelectorAll<HTMLInputElement>('input')].map((input) => input.id)).toEqual(['kiroku-hint-0', 'kiroku-hint-1'])
    expect([...body.querySelectorAll('label')].map((label) => label.textContent)).toEqual(['Show First', 'Show Second'])
  })
  test('renders trusted imported media tokens inline and respects surrounding conditionals', () => {
    const fields = { Show: 'yes', Media: 'before [[kiroku-media:cat.png]] after' }
    const media = { 'cat.png': { kind: 'image' as const, url: 'blob:cat' } }
    expect(renderTemplate('{{#Show}}{{Media}}{{/Show}}', fields, undefined, { media }).html)
      .toBe('before <img class="card-image" src="blob:cat" alt="cat.png"> after')
    expect(renderTemplate('{{#Show}}{{Media}}{{/Show}}', { ...fields, Show: '' }, undefined, { media }).html).toBe('')
  })
  test('renders media embedded directly in a template without a network URL', () => {
    const media = { '猫.png': { kind: 'image' as const, url: 'data:image/png;base64,AQID' } }
    expect(renderTemplate('[[kiroku-media:%E7%8C%AB.png]]', {}, undefined, { media })).toEqual({
      html: '<img class="card-image" src="data:image/png;base64,AQID" alt="猫.png">',
      isEmpty: false,
    })
  })
  test('removes untrusted template resource elements while preserving local media placeholders', () => {
    const media = { '猫.png': { kind: 'image' as const, url: 'blob:verified-media' } }
    const rendered = renderTemplate('<script>parent.fetch("/api/backups")</script><img src="https://attacker.invalid/x"><iframe src="file:///private/anki.anki2"></iframe><svg><image href="file:///private/anki.anki2"></image></svg><b>[[kiroku-media:%E7%8C%AB.png]]</b>', {}, undefined, { media })
    expect(rendered.html).toBe('<b><img class="card-image" src="blob:verified-media" alt="猫.png"></b>')
    expect(rendered.html).not.toMatch(/attacker|file:|<script|<iframe/i)
  })

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
  test('escapes field values by default and keeps text-filter values escaped', () => {
    expect(renderTemplate('<b>{{Word}}</b>', { Word: '<img src=x onerror=alert(1)>&"' })).toEqual({
      html: '<b>&lt;img src=x onerror=alert(1)&gt;&amp;&quot;</b>',
      isEmpty: false,
    })
    expect(renderTemplate('{{text:Word}}', { Word: '<img src=x onerror=alert(1)>&"' }).html)
      .toBe('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;')
  })

  test('preserves only explicitly marked imported HTML fields after sanitizing them', () => {
    expect(renderTemplate('{{Word}}', { Word: '<table><tr><td>猫</td></tr></table>' }, undefined, { htmlFields: new Set(['Word']) }).html)
      .toBe('<table><tbody><tr><td>猫</td></tr></tbody></table>')
    expect(renderTemplate('{{Word}}', { Word: '<b>猫</b>' }).html).toBe('&lt;b&gt;猫&lt;/b&gt;')
  })

  test('preserves field layout HTML while removing active elements and unsafe attributes', () => {
    const result = sanitizeFieldHtml('<table onclick="run()"><tr><td style="width:50%;background-image:url(https://evil.test/x)"><b>猫</b></td><td><script>alert(1)</script><img src=x onerror="run()">&lt;script&gt;</td></tr></table>')
    expect(result.hadMarkup).toBe(true)
    expect(result.html).toContain('<table>')
    expect(result.html).toContain('<td style="width: 50%">')
    expect(result.html).toContain('<b>猫</b>')
    expect(result.html).toContain('&lt;script&gt;')
    expect(result.html).not.toMatch(/<script|<img|onclick|onerror|background-image/i)
    expect(result.removed).toEqual(expect.arrayContaining(['<script>', '<img>', 'onclick', 'style:background-image']))
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

  test('nested conditionals require every parent and resume siblings after closing', () => {
    const template = '{{#A}}outer{{#B}}{{B}}{{/B}}tail{{/A}}end'
    expect(() => validateTemplate(template, ['A', 'B'], 'front')).not.toThrow()
    expect(renderTemplate(template, { A: 'a', B: 'b' }).html).toBe('outerbtailend')
    expect(renderTemplate(template, { A: '', B: 'b' }).html).toBe('end')
    expect(renderTemplate(template, { A: 'a', B: '' }).html).toBe('outertailend')
    expect(renderTemplate('{{#A}}{{^B}}missing{{/B}}{{/A}}', { A: 'a', B: '' }).html).toBe('missing')
    expect(renderTemplate('{{#A}}{{^B}}missing{{/B}}{{/A}}', { A: '', B: '' }).html).toBe('')
    expect([...templateMediaFields(template, { A: '', B: 'image' })]).toEqual([])
    expect([...templateMediaFields(template, { A: 'a', B: 'image' })]).toEqual(['B'])
    expect(() => validateTemplate('{{#A}}{{#B}}{{/A}}{{/B}}', ['A', 'B'], 'front')).toThrow(/Unmatched template conditional/)
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
