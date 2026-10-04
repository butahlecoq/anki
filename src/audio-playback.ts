export async function replayAudioElements(elements: HTMLMediaElement[]): Promise<boolean> {
  const results = await Promise.allSettled(elements.map(async (element) => {
    element.currentTime = 0
    await element.play()
  }))
  return results.some((result) => result.status === 'fulfilled')
}
