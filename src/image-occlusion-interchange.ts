import type { OcclusionMask } from './collection'

/** Rectangular, hide-one subset of Anki's native Image Occlusion fields. */
export interface AnkiImageOcclusionFields { Occlusion: string; Image: string; Header: string; 'Back Extra': string; Comments: string }
export interface ParsedAnkiImageOcclusion { imageName: string; header: string; backExtra: string; comments: string; masks: OcclusionMask[] }

function unit(value: string, label: string): number {
  if (!value.trim()) throw new Error(`Anki image occlusion ${label} is missing`)
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`Anki image occlusion ${label} is invalid`)
  return number
}

export function parseAnkiImageOcclusion(fields: AnkiImageOcclusionFields): ParsedAnkiImageOcclusion {
  const image = fields.Image.match(/^<img\s+src="([^"<>]+)">$/i)
  if (!image || /[/\\]/.test(image[1]) || image[1] === '.' || image[1] === '..') throw new Error('Anki image occlusion image reference is unsupported')
  const token = /{{c([1-9]\d*)::image-occlusion:([^{}]+)}}(?:<br>)?/g
  const masks: OcclusionMask[] = []
  const remainder = fields.Occlusion.replace(token, (_full, rawOrdinal: string, rawShape: string) => {
    const [shape, ...parts] = rawShape.split(':')
    if (shape !== 'rect') throw new Error(`Unsupported Anki image occlusion shape: ${shape}`)
    const properties = new Map(parts.map((part) => {
      const separator = part.indexOf('=')
      if (separator < 1) throw new Error('Anki image occlusion rectangle is malformed')
      return [part.slice(0, separator), part.slice(separator + 1)] as const
    }))
    if (properties.size !== 4 || [...properties.keys()].some((key) => !['left', 'top', 'width', 'height'].includes(key))) throw new Error('Unsupported Anki image occlusion rectangle property')
    const ordinal = Number(rawOrdinal)
    if (!Number.isSafeInteger(ordinal) || masks.some((mask) => mask.ordinal === ordinal)) throw new Error('Grouped or duplicate Anki image occlusions are unsupported')
    const x = unit(properties.get('left') ?? '', 'left')
    const y = unit(properties.get('top') ?? '', 'top')
    const width = unit(properties.get('width') ?? '', 'width')
    const height = unit(properties.get('height') ?? '', 'height')
    if (!width || !height || x + width > 1 || y + height > 1) throw new Error('Anki image occlusion rectangle is out of bounds')
    masks.push({ id: `anki-c${ordinal}`, ordinal, x, y, width, height })
    return ''
  })
  if (remainder.trim() || !masks.length) throw new Error('Unsupported Anki image occlusion content')
  return { imageName: image[1], header: fields.Header, backExtra: fields['Back Extra'], comments: fields.Comments, masks }
}

function displayUnit(value: number) {
  return String(value).replace(/^0\./, '.')
}

export function serializeAnkiImageOcclusion(value: ParsedAnkiImageOcclusion): AnkiImageOcclusionFields {
  if (!value.masks.length) throw new Error('At least one image occlusion mask is required')
  return {
    Occlusion: value.masks.map((mask) => `{{c${mask.ordinal}::image-occlusion:rect:left=${displayUnit(mask.x)}:top=${displayUnit(mask.y)}:width=${displayUnit(mask.width)}:height=${displayUnit(mask.height)}}}<br>`).join(''),
    Image: `<img src="${value.imageName}">`,
    Header: value.header,
    'Back Extra': value.backExtra,
    Comments: value.comments,
  }
}
