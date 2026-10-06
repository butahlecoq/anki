import { learningActivities } from './learning-activities'

export function ActivitySelection({ onSelect, onBack }: { onSelect: (activityId: string) => void; onBack: () => void }) {
  return <section className="activity-selection" aria-labelledby="activity-selection-title">
    <button className="text-button back-button" type="button" onClick={onBack}>← Back</button>
    <span className="section-code">STUDY // CHOOSE AN ACTIVITY</span>
    <h1 id="activity-selection-title">Choose how to study</h1>
    <p>Activities change how you practise. Your review grade still controls scheduling.</p>
    <div className="activity-list">
      {learningActivities.map((activity) => <article className="activity-option" key={activity.id}>
        <div><h2>{activity.title}</h2><p>{activity.description}</p></div>
        <button className="primary-action" type="button" onClick={() => onSelect(activity.id)}>Start {activity.title}</button>
      </article>)}
    </div>
  </section>
}
