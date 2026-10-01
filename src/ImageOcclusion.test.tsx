import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ImageOcclusionCanvas, normalizeOcclusionRect } from './ImageOcclusion'

describe('image occlusion canvas', () => {
  afterEach(cleanup)
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

  test('removes an unfinished mask when a pointer gesture is cancelled', () => {
    render(<ImageOcclusionCanvas imageUrl="blob:test" masks={[]} />)
    const canvas = screen.getByLabelText('Draw image occlusion masks')
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 400, height: 200 }) })
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 40, clientY: 20 })
    fireEvent.pointerCancel(canvas, { pointerId: 1 })
    expect(screen.queryByRole('button', { name: 'Remove mask 1' })).not.toBeInTheDocument()
  })

  test('keeps a supplied mask identity when editor controls move and resize it', () => {
    const onChange = vi.fn()
    render(<ImageOcclusionCanvas imageUrl="blob:test" masks={[{ id: 'alpha', ordinal: 7, x: .1, y: .2, width: .3, height: .4 }]} onChange={onChange} />)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Mask 1 x position' }), { target: { value: '20' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Mask 1 width' }), { target: { value: '40' } })
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'alpha', ordinal: 7, x: .2, y: .2, width: .4, height: .4 }])
  })

  test('keeps identity through pointer move, resize, and removal', () => {
    const onChange = vi.fn()
    const { container } = render(<ImageOcclusionCanvas imageUrl="blob:test" masks={[
      { id: 'alpha', ordinal: 7, x: .1, y: .1, width: .2, height: .2 },
      { id: 'beta', ordinal: 8, x: .6, y: .6, width: .2, height: .2 },
    ]} onChange={onChange} />)
    const canvas = screen.getByLabelText('Draw image occlusion masks')
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 400, height: 400 }) })

    fireEvent.pointerDown(container.querySelector('.occlusion-selection')!, { pointerId: 1, clientX: 80, clientY: 80 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 120 })
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 120, clientY: 120 })
    fireEvent.pointerDown(container.querySelector('.occlusion-resize')!, { pointerId: 2, clientX: 160, clientY: 160 })
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 200, clientY: 240 })
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 200, clientY: 240 })

    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'alpha', ordinal: 7, x: .2, y: .2, width: .3, height: .4 },
      { id: 'beta', ordinal: 8, x: .6, y: .6, width: .2, height: .2 },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Remove mask 1' }))
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'beta', ordinal: 8, x: .6, y: .6, width: .2, height: .2 }])
  })

  test('shows only the active mask after revealing a multi-mask review card', () => {
    const { container } = render(<ImageOcclusionCanvas
      imageUrl="blob:test"
      readOnly
      activeMaskId="alpha"
      revealActive
      masks={[
        { id: 'alpha', ordinal: 1, x: .1, y: .1, width: .2, height: .2 },
        { id: 'beta', ordinal: 2, x: .6, y: .6, width: .2, height: .2 },
      ]}
    />)
    expect(container.querySelectorAll('.occlusion-revealed-mask')).toHaveLength(1)
    expect(container.querySelectorAll('.occlusion-mask')).toHaveLength(1)
  })

  test('refreshes masks when a synced review note is remounted', () => {
    const { rerender } = render(<ImageOcclusionCanvas key="before-sync" imageUrl="blob:test" readOnly masks={[{ id: 'alpha', ordinal: 1, x: .1, y: .1, width: .2, height: .2 }]} />)
    expect(document.querySelectorAll('.occlusion-mask')).toHaveLength(1)
    rerender(<ImageOcclusionCanvas key="after-sync" imageUrl="blob:test" readOnly masks={[
      { id: 'alpha', ordinal: 1, x: .1, y: .1, width: .2, height: .2 },
      { id: 'beta', ordinal: 2, x: .6, y: .6, width: .2, height: .2 },
    ]} />)
    expect(document.querySelectorAll('.occlusion-mask')).toHaveLength(2)
  })
})
