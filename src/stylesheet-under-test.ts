import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * Reads the shipped front-end sources for the design-system suites.
 *
 * These helpers run under Node, so the suites that use them are type-checked by
 * tsconfig.node.json. Vitest always runs from the repository root.
 */
export const stylesheet = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The document shell, whose meta tags the installed PWA is described by. */
export const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8').replace(/\r\n/g, '\n')

/**
 * Reads a front-end source file, so a suite can assert on a rule that lives in
 * a component rather than in the stylesheet.
 *
 * The card document is built as a string inside src/TemplatePreview.tsx, which
 * the stylesheet-only readers above cannot see. Reading the source is what lets
 * src/design-tokens.test.ts hold those colours to the same contrast contract as
 * the tokens it already checks.
 */
export function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
}

/** Returns the declaration body of the rule for an exact selector. */
export function rule(selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`missing rule for ${selector}`)
  const open = stylesheet.indexOf('{', start)
  return stylesheet.slice(open + 1, stylesheet.indexOf('}', open))
}

/** Returns the concatenated bodies of every media query with this condition. */
export function mediaBlock(condition: string): string {
  const marker = `@media (${condition}) {`
  const bodies: string[] = []
  let cursor = stylesheet.indexOf(marker)
  if (cursor < 0) throw new Error(`missing @media (${condition}) block`)
  while (cursor !== -1) {
    let depth = 0
    for (let index = stylesheet.indexOf('{', cursor); index < stylesheet.length; index += 1) {
      if (stylesheet[index] === '{') depth += 1
      else if (stylesheet[index] === '}' && (depth -= 1) === 0) {
        bodies.push(stylesheet.slice(stylesheet.indexOf('{', cursor) + 1, index))
        break
      }
    }
    cursor = stylesheet.indexOf(marker, cursor + marker.length)
  }
  return bodies.join('\n')
}
