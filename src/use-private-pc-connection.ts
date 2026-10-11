import { useEffect, useRef, useState } from 'react'
import { collection } from './collection'
import { connectPrivatePc, type PrivatePcConnectionResult } from './sync-client'

export function usePrivatePcConnection() {
  const [state, setState] = useState<PrivatePcConnectionResult['state'] | 'connecting'>('connecting')
  const attempt = useRef<Promise<PrivatePcConnectionResult> | undefined>(undefined)
  const mounted = useRef(false)
  const pending = useRef(true)
  useEffect(() => {
    mounted.current = true
    // Development effect replay shares this attempt, avoiding two grants.
    attempt.current ??= connectPrivatePc(collection, window.location.origin)
    void attempt.current.then(result => {
      pending.current = false
      if (mounted.current) setState(result.state)
    })
    return () => { mounted.current = false }
  }, [])
  async function retry() {
    if (pending.current) return
    pending.current = true
    setState('connecting')
    attempt.current = connectPrivatePc(collection, window.location.origin)
    const result = await attempt.current
    pending.current = false
    if (mounted.current) setState(result.state)
  }
  return { state, retry }
}
