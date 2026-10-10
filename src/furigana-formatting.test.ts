import { expect, test } from 'vitest'
import { renderTemplate } from './template-renderer'

const options = { htmlFields: new Set(['Reading']) }

test('rich furigana preserves bold without exposing tag characters', () => {
  const result = renderTemplate('{{furigana:Reading}}', { Reading: '<b>新[あら]たな</b> 計[けい]画[かく] &amp; text' }, undefined, options)
  expect(result.html).toContain('<b><ruby>新<rt>あら</rt></ruby>たな</b>')
  expect(result.html).toContain('<ruby>計<rt>けい</rt></ruby>')
  expect(result.html).toContain('&amp; text')
  expect(result.html).not.toContain('&lt;b&gt;')
})

test('rich reading filters sanitize markup while literal plain fields remain escaped', () => {
  const fields = { Reading: '<b>新[あら]たな</b><script>unsafe()</script>' }
  const rich = renderTemplate('{{furigana:Reading}}', fields, undefined, options)
  expect(rich.html).not.toContain('<script>')
  expect(rich.html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
  expect(renderTemplate('{{furigana:Reading}}', fields).html).toContain('&lt;b&gt;')
})

test('text filter removes rich markup while preserving literal plain text', () => {
  const fields = { Reading: '<b>新たな</b> &amp; text' }
  expect(renderTemplate('{{text:Reading}}', fields, undefined, options).html).toBe('新たな &amp; text')
  expect(renderTemplate('{{text:Reading}}', fields).html).toContain('&lt;b&gt;')
})
