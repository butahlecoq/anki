import { expect, test } from 'vitest'
import { studyCardHtml } from './study-card-presentation'

test('study keeps learning content and media while removing small linked footer boilerplate', () => {
  const original = '<p>Learn <a data-kiroku-href="https://example.com/word">猫</a></p><ruby>猫<rt>ねこ</rt></ruby><audio controls src="blob:audio"></audio><img src="blob:image"><p style="font-size:70%">Deck version: 14 · <a data-kiroku-href="https://example.com/support">Support</a></p><div class="bottomlink"><a data-kiroku-href="https://example.com/report">Report a mistake</a></div>'
  const html = studyCardHtml(original)
  expect(html).toContain('<p>Learn 猫</p>')
  expect(html).toContain('<ruby>猫<rt>ねこ</rt></ruby>')
  expect(html).toContain('<audio controls="" src="blob:audio"></audio>')
  expect(html).toContain('<img src="blob:image">')
  expect(html).not.toMatch(/<a\b|Deck version|Support|Report a mistake/)
  expect(original).toContain('Deck version: 14')
})

test('small educational notes without links remain visible', () => {
  const original = '<p style="font-size:70%">This verb takes an object.</p>'
  expect(studyCardHtml(original)).toBe(original)
})

test('Russian runs receive readable presentation without changing Japanese ruby or bold', () => {
  const html = studyCardHtml('<ruby>猫<rt>ねこ</rt></ruby><div><b>Жестокий</b>; ужасный; сильный</div>')
  const fragment = document.createElement('template')
  fragment.innerHTML = html
  expect(fragment.content.querySelector('ruby')?.outerHTML).toBe('<ruby>猫<rt>ねこ</rt></ruby>')
  expect(fragment.content.querySelector('b .kiroku-translation')?.textContent).toBe('Жестокий')
  expect([...fragment.content.querySelectorAll('.kiroku-translation')].map(element => element.textContent).join(' ')).toContain('ужасный; сильный')
  expect(fragment.content.textContent).toBe('猫ねこЖестокий; ужасный; сильный')
})
