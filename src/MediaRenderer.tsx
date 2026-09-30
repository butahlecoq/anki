import { useEffect, useState } from 'react'
import { collection, type NoteMediaReference } from './collection'

export function MediaRenderer({ reference, automatic = false }: { reference: NoteMediaReference; automatic?: boolean }) {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    let active = true
    let objectUrl: string | undefined
    void collection.verifiedMediaBlob(reference.digest).then((stored) => {
      if (!active || !stored) return
      objectUrl = URL.createObjectURL(stored.blob)
      setUrl(objectUrl)
    })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [reference.digest])

  if (!url) return <p className="media-pending" role="status">{reference.displayName} will be available after its media sync finishes.</p>
  if (reference.kind === 'image') return <img className="card-image" src={url} alt={reference.displayName} />
  return <audio className="card-audio" controls autoPlay={automatic && reference.playback === 'automatic'} src={url}>Audio: {reference.displayName}</audio>
}
