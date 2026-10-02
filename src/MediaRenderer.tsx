import type { NoteMediaReference } from './collection'

export function MediaRenderer({ reference, url, automatic = false }: { reference: NoteMediaReference; url?: string; automatic?: boolean }) {
  if (!url) return <p className="media-pending" role="status">{reference.displayName} will be available after its media sync finishes.</p>
  if (reference.kind === 'image') return <img className="card-image" src={url} alt={reference.displayName} />
  return <audio className="card-audio" controls autoPlay={automatic && reference.playback === 'automatic'} src={url}>Audio: {reference.displayName}</audio>
}
