import { expect, test } from 'vitest'
import { renderTemplate } from './template-renderer'
import { safeNavigationURL, supportedNavigationTemplate } from './template-navigation'

test('navigation permits only explicit HTTPS without credentials or control characters', () => {
  expect(safeNavigationURL('https://example.org/猫?q=日本語')).toBe('https://example.org/%E7%8C%AB?q=%E6%97%A5%E6%9C%AC%E8%AA%9E')
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'http://example.org', '//example.org', 'https://user:secret@example.org', 'https://example.org/\nnext']) expect(safeNavigationURL(value)).toBeNull()
  expect(supportedNavigationTemplate('https://example.org/?q={{Expression}}')).toBe(true)
  expect(supportedNavigationTemplate('{{URL}}')).toBe(true)
  expect(supportedNavigationTemplate('javascript:{{Expression}}')).toBe(false)
  expect(supportedNavigationTemplate('https://example.org/{{Expression')).toBe(false)
})

test('field URLs are resolved before parsing values as markup and cannot inject attributes', () => {
  const rendered = renderTemplate('<a href={{URL}} target=_top ping="https://evil.invalid" onclick="alert(1)">{{Word}}</a>', { URL: 'https://example.org/path?x=" onmouseover="alert(1)', Word: '猫' })
  const inert = document.createElement('template'); inert.innerHTML = rendered.html
  const anchor = inert.content.querySelector('a')!
  expect(anchor.getAttribute('data-kiroku-href')).toBe('https://example.org/path?x=%22%20onmouseover=%22alert(1)')
  for (const name of ['href', 'target', 'ping', 'onclick', 'onmouseover']) expect(anchor.hasAttribute(name)).toBe(false)
  expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  expect(anchor.textContent).toBe('猫')
  expect(rendered.isEmpty).toBe(false)
})

test('URL-only field remains card content; unsafe synced URLs become inert', () => {
  expect(renderTemplate('<a href="{{URL}}">Dictionary</a>', { URL: 'https://example.org/猫' }).isEmpty).toBe(false)
  const unsafe = renderTemplate('<a href="{{URL}}">{{Word}}</a>', { URL: 'javascript:alert(1)', Word: '猫' }).html
  expect(unsafe).not.toContain('href=')
  expect(unsafe).toContain('aria-disabled="true"')
  const literal = renderTemplate('<a href="https://example.org/{{Word}}">{{Word}}</a>', { Word: '{{Other}}', Other: 'injected' }).html
  expect(literal).toContain('%7B%7BOther%7D%7D')
  expect(literal).not.toContain('/injected')
})
