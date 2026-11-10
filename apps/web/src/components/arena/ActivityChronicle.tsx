"use client";

interface ChronicleEvent {
  id: string;
  type: string;
  timestamp: string;
  source: string;
  entity: string;
  network: string | null;
  verified: boolean | null;
  link: string | null;
}

/**
 * ActivityChronicle — a real activity feed from authoritative backend events.
 *
 * Each event shows ID, type, timestamp, source, entity, network, verification
 * status, and a link to the detail page. Seeded/demo events are visibly
 * labelled; never fake live activity.
 */
export function ActivityChronicle({ events }: { events: ChronicleEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="surface activity-chronicle" aria-label="Activity feed">
        <h3 className="activity-chronicle__title">Activity</h3>
        <p className="activity-chronicle__empty">No recent activity.</p>
      </div>
    );
  }

  return (
    <div className="surface activity-chronicle" aria-label="Activity feed">
      <h3 className="activity-chronicle__title">Activity</h3>
      <ul className="activity-chronicle__list">
        {events.map((event) => (
          <li key={event.id} className="activity-chronicle__item">
            <span className="activity-chronicle__time mono">
              {new Date(event.timestamp).toISOString()}
            </span>
            <span className="activity-chronicle__type">{event.type}</span>
            <span className="activity-chronicle__entity mono">{event.entity}</span>
            {event.network && (
              <span className="activity-chronicle__network mono">{event.network}</span>
            )}
            <span
              className="activity-chronicle__verified mono"
              data-tone={event.verified === true ? "quench" : event.verified === false ? "sear" : "faint"}
            >
              {event.verified === true ? "Verified" : event.verified === false ? "Failed" : "Unverified"}
            </span>
            {event.link && (
              <a href={event.link} className="activity-chronicle__link">
                View detail
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
