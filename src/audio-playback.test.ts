import { expect, test, vi } from 'vitest'
import { replayAudioElements } from './audio-playback'

test('replays when at least one audio element can play', async () => {
  const first = { currentTime: 4, play: vi.fn(async () => {}) } as unknown as HTMLMediaElement
  const second = { currentTime: 9, play: vi.fn(async () => { throw new Error('unsupported') }) } as unknown as HTMLMediaElement

  await expect(replayAudioElements([first, second])).resolves.toBe(true)
  expect(first.currentTime).toBe(0)
  expect(second.currentTime).toBe(0)
})

test('reports failure when every audio element rejects playback', async () => {
  const element = { currentTime: 4, play: vi.fn(async () => { throw new Error('unsupported') }) } as unknown as HTMLMediaElement

  await expect(replayAudioElements([element])).resolves.toBe(false)
  expect(element.currentTime).toBe(0)
})
