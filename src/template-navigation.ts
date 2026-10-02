/** Navigation is never a media resource: only a learner-confirmed HTTPS action. */
export function safeNavigationURL(value: string): string | null {
  if (!/^https:\/\//i.test(value.trim()) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
    return url.href
  } catch { return null }
}

const substitution = /{{\s*([^{}]+?)\s*}}/g
const anchorTag = /<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi

export function supportedNavigationTemplate(value: string): boolean {
  const masked = value.replace(substitution, 'kiroku-field')
  if (/{{|}}/.test(masked)) return false
  // A complete URL field is validated after rendering; no other scheme is inferred.
  return Boolean(safeNavigationURL(masked)) || /^{{\s*(?:text:)?[^{}]+?\s*}}$/.test(value.trim())
}

/** Quote attributes before ordinary field rendering, including unquoted href inputs. */
export function resolveTemplateNavigation(template: string, fields: Record<string, string>) {
  let hasContent = false
  const markup = template.replace(anchorTag, (tag) => {
    const inert = document.createElement('template')
    inert.innerHTML = tag
    const anchor = inert.content.querySelector('a')
    if (!anchor) return tag
    const raw = anchor.getAttribute('href')
    anchor.removeAttribute('data-kiroku-href')
    for (const attribute of [...anchor.attributes]) {
      if (attribute.name.startsWith('on') || ['target', 'ping', 'download', 'referrerpolicy'].includes(attribute.name)) anchor.removeAttribute(attribute.name)
    }
    if (raw === null) return anchor.outerHTML.replace(/<\/a>$/, '')
    let fieldContent = false
    const expanded = raw.replace(substitution, (_source, name: string) => {
      const exact = name.trim()
      const field = Object.hasOwn(fields, exact) ? exact : exact.startsWith('text:') ? exact.slice(5) : exact
      const value = fields[field] ?? ''
      fieldContent ||= Boolean(value.trim())
      return value
    })
    const url = safeNavigationURL(expanded)
    if (url) {
      // Prevent a URL field from becoming another template instruction.
      anchor.removeAttribute('href')
      anchor.setAttribute('data-kiroku-href', url.replace(/{/g, '%7B').replace(/}/g, '%7D'))
      anchor.setAttribute('role', 'link')
      anchor.setAttribute('tabindex', '-1')
      anchor.setAttribute('aria-disabled', 'true')
      anchor.setAttribute('title', 'Preparing external link')
      anchor.setAttribute('rel', 'noopener noreferrer')
      hasContent ||= fieldContent
    } else {
      anchor.removeAttribute('href')
      anchor.setAttribute('aria-disabled', 'true')
      anchor.setAttribute('title', 'External link unavailable: use a valid HTTPS URL without credentials.')
    }
    return anchor.outerHTML.replace(/<\/a>$/, '')
  })
  return { markup, hasContent }
}

export function renderedNavigationActions(html: string) {
  const inert = document.createElement('template')
  inert.innerHTML = html
  return [...inert.content.querySelectorAll('a[data-kiroku-href]')].flatMap(anchor => {
    const url = safeNavigationURL(anchor.getAttribute('data-kiroku-href') ?? '')
    return url ? [{ url, label: anchor.textContent?.trim().slice(0, 100) || 'External page', host: new URL(url).hostname }] : []
  })
}
