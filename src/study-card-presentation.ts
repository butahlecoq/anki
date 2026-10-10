function linkedFooter(element: Element) {
  if (element.matches('footer, .bottomlink')) return true
  if (!(element instanceof HTMLElement) || element.tagName !== 'P') return false
  const size = element.style.fontSize
  return size.endsWith('%') ? Number.parseFloat(size) <= 75
    : size.endsWith('em') && Number.parseFloat(size) <= 0.75
}

/** Adapt a study document without changing its stored fields or template. */
export function studyCardHtml(html: string): string {
  const fragment = document.createElement('template')
  fragment.innerHTML = html
  for (const link of [...fragment.content.querySelectorAll('a')]) {
    let parent = link.parentElement
    while (parent && !linkedFooter(parent)) parent = parent.parentElement
    if (parent) parent.remove()
    else link.replaceWith(...link.childNodes)
  }
  const translations = (parent: ParentNode) => {
    for (const child of [...parent.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && /\p{Script=Cyrillic}/u.test(child.textContent ?? '')) {
        const value = child.textContent ?? ''
        const replacement = document.createDocumentFragment()
        let cursor = 0
        for (const match of value.matchAll(/[\p{Script=Cyrillic}][\p{Script=Cyrillic}\p{Script=Latin}\p{N}\s.,;:!?()"'«»–—-]*/gu)) {
          replacement.append(document.createTextNode(value.slice(cursor, match.index)))
          const text = document.createElement('span')
          text.className = 'kiroku-translation'
          text.textContent = match[0]
          replacement.append(text)
          cursor = match.index + match[0].length
        }
        replacement.append(document.createTextNode(value.slice(cursor)))
        child.replaceWith(replacement)
      } else if (child instanceof Element && !child.matches('rt, rp, audio, video')) translations(child)
    }
  }
  translations(fragment.content)
  return fragment.innerHTML
}
