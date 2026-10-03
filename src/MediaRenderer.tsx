import type { CardMediaDescription } from './card-rendering'

export function MediaRenderer({ description }: { description: CardMediaDescription }) {
  if (!description.url) return <p className="media-pending" role="status">{description.displayName} will be available after its media sync finishes.</p>
  if (description.kind === 'image') return <img className="card-image" src={description.url} alt={description.displayName} />
  return <audio className="card-audio" controls autoPlay={description.playback === 'automatic'} src={description.url}>Audio: {description.displayName}</audio>
}
