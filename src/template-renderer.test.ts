import { describe, expect, test } from 'vitest'
import { renderTemplate, validateTemplate } from './template-renderer'

describe('renderTemplate', () => {
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
})
