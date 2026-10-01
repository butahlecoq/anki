import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { ImageOcclusionCanvas, normalizeOcclusionRect } from './ImageOcclusion'

describe('image occlusion canvas', () => {
  test('normalizes a drag in either direction and keeps it within the image', () => {
    expect(normalizeOcclusionRect({ x: .8, y: .7 }, { x: .2, y: .1 })).toEqual({ x: .2, y: .1, width: .6, height: .6 })
    expect(normalizeOcclusionRect({ x: -.3, y: .4 }, { x: .4, y: 1.3 })).toEqual({ x: 0, y: .4, width: .4, height: .6 })
  })

  test('draws a mask with pointer input and offers accessible keyboard controls', () => {
    const change = () => undefined
    render(<ImageOcclusionCanvas imageUrl="blob:test" masks={[]} onChange={change} />)

    const canvas = screen.getByLabelText('Draw image occlusion masks')
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 400, height: 200 }) })
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 40, clientY: 20 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 200, clientY: 100 })
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 200, clientY: 100 })

    expect(screen.getByRole('button', { name: 'Remove mask 1' })).toBeVisible()
    expect(screen.getByRole('spinbutton', { name: 'Mask 1 x position' })).toHaveValue(10)
    expect(screen.getByRole('spinbutton', { name: 'Mask 1 width' })).toHaveValue(40)
  })
})
