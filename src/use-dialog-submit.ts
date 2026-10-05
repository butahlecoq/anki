import { useCallback, useRef, useState } from 'react'

/**
 * One guarded submit lifecycle for collection dialogs: ignore duplicate submits,
 * show operation failures beside the form, and run close/navigation only after
 * the operation succeeds.
 */
export function useDialogSubmit() {
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)

  const submit = useCallback(async (
    action: () => void | Promise<void>,
    fallback: string,
    onSuccess?: () => void,
  ) => {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      await action()
      onSuccess?.()
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : fallback)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }, [])

  return { error, setError, submitting, submit }
}
