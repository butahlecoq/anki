import { safeNavigationURL } from './template-navigation'

const allowedTags = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CAPTION', 'CITE', 'CODE', 'COL', 'COLGROUP',
  'DD', 'DEL', 'DIV', 'DL', 'DT', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR',
  'I', 'INS', 'KBD', 'LI', 'OL', 'P', 'PRE', 'Q', 'RUBY', 'RP', 'RT', 'S', 'SMALL',
  'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD',
  'TR', 'U', 'UL', 'WBR',
])
const dropContentsTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT'])
const htmlTagPattern = /<\/?[a-z][^>]*>/i
const allowedStyleProperties = new Set([
  'background-color', 'border', 'border-bottom', 'border-collapse', 'border-color', 'border-left',
  'border-right', 'border-spacing', 'border-style', 'border-top', 'border-width', 'color', 'display',
  'font-size', 'font-style', 'font-weight', 'line-height', 'margin', 'margin-bottom', 'margin-left',
  'margin-right', 'margin-top', 'max-width', 'min-width', 'padding', 'padding-bottom', 'padding-left',
  'padding-right', 'padding-top', 'text-align', 'text-decoration', 'vertical-align', 'white-space', 'width',
])

export interface SanitizedFieldHtml {
  html: string
  hadMarkup: boolean
  preservedMarkup: boolean
  removed: string[]
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

/** Decode entities as text without interpreting angle-bracket text as elements. */
export function decodeFieldText(value: string) {
  const textarea = document.createElement('textarea')
  textarea.innerHTML = value.replace(/</g, '&lt;')
  return textarea.value
}

function safeStyle(value: string) {
  const kept: string[] = []
  const removed: string[] = []
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 1) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const setting = declaration.slice(colon + 1).trim()
    if (!allowedStyleProperties.has(property) || !setting || /url\s*\(|expression\s*\(|javascript\s*:|@import|var\s*\(|[{}]/i.test(setting)) {
      removed.push(`style:${property || 'invalid'}`)
    } else {
      kept.push(`${property}: ${setting}`)
    }
  }
  return { value: kept.join('; '), removed }
}

/** Retain common field layout markup while dropping active content and unsafe attributes. */
export function sanitizeFieldHtml(value: string): SanitizedFieldHtml {
  const hadMarkup = htmlTagPattern.test(value)
  if (!hadMarkup) return { html: escapeHtml(decodeFieldText(value)), hadMarkup: false, preservedMarkup: false, removed: [] }
  const parsed = document.createElement('template')
  parsed.innerHTML = value
  const removed = new Set<string>()
  const cleanChildren = (parent: ParentNode) => {
    for (const child of [...parent.children]) {
      if (dropContentsTags.has(child.tagName)) {
        removed.add(`<${child.tagName.toLowerCase()}>`)
        child.replaceWith(document.createTextNode(child.outerHTML))
        continue
      }
      cleanChildren(child)
      if (!allowedTags.has(child.tagName)) {
        removed.add(`<${child.tagName.toLowerCase()}>`)
        child.replaceWith(...child.childNodes)
        continue
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase()
        if (name === 'style') {
          const style = safeStyle(attribute.value)
          style.removed.forEach((entry) => removed.add(entry))
          if (style.value) child.setAttribute('style', style.value)
          else child.removeAttribute('style')
        } else if (name === 'class') {
          const original = attribute.value.split(/\s+/).filter(Boolean)
          const classes = original.filter((token) => /^[\w-]{1,80}$/.test(token))
          if (classes.length) child.setAttribute('class', classes.join(' '))
          else child.removeAttribute('class')
          if (classes.length !== original.length) removed.add('class')
        } else if (['title', 'lang', 'dir'].includes(name)) {
          if (name === 'dir' && !['ltr', 'rtl', 'auto'].includes(attribute.value.toLowerCase())) {
            child.removeAttribute(attribute.name)
            removed.add(name)
          }
        } else if (['colspan', 'rowspan'].includes(name) && ['TD', 'TH'].includes(child.tagName)) {
          if (!/^[1-9]\d{0,3}$/.test(attribute.value)) {
            child.removeAttribute(attribute.name)
            removed.add(name)
          }
        } else if (child.tagName === 'A' && name === 'href') {
          const url = safeNavigationURL(attribute.value)
          if (url) child.setAttribute('href', url)
          else {
            child.removeAttribute(attribute.name)
            removed.add('href')
          }
        } else {
          child.removeAttribute(attribute.name)
          removed.add(name)
        }
      }
    }
  }
  cleanChildren(parsed.content)
  return { html: parsed.innerHTML, hadMarkup, preservedMarkup: htmlTagPattern.test(parsed.innerHTML), removed: [...removed].sort() }
}
