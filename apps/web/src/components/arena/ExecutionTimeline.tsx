"use client";

interface TimelineEvent {
  id: string;
  time: string | null;
  type: string;
  description: string;
  status: "pending" | "complete" | "failed";
}

/**
 * ExecutionTimeline — the ordered execution timeline for a trial run.
 *
 * Shows events with time, type, description, and status. Bounded rendering —
 * never unbounded. Pagination/virtualization handled by the parent for long lists.
 */
export function ExecutionTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="surface execution-timeline" aria-label="Execution timeline">
        <h3 className="execution-timeline__title">Execution timeline</h3>
        <p className="execution-timeline__empty">No execution events yet.</p>
      </div>
    );
  }

  return (
    <div className="surface execution-timeline" aria-label="Execution timeline">
      <h3 className="execution-timeline__title">Execution timeline</h3>
      <ul className="execution-timeline__list">
        {events.map((event) => (
          <li key={event.id} className="execution-timeline__item">
            <span className="execution-timeline__time mono">
              {event.time ? new Date(event.time).toISOString() : "—"}
            </span>
            <span className="execution-timeline__type">{event.type}</span>
            <p className="execution-timeline__desc">{event.description}</p>
            <span
              className="execution-timeline__status mono"
              data-tone={
                event.status === "complete"
                  ? "quench"
                  : event.status === "failed"
                    ? "sear"
                    : "faint"
              }
            >
              {event.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
