"use client";

interface LogEntry {
  id: string;
  time: string | null;
  level: "info" | "warn" | "error";
  message: string;
}

/**
 * ExecutionLog — bounded execution logs with pagination/filtering.
 *
 * Never renders unbounded logs. The parent must pass a bounded, paginated set.
 * Each entry shows time, level, and message.
 */
export function ExecutionLog({ entries, onLoadMore }: { entries: LogEntry[]; onLoadMore?: () => void }) {
  if (entries.length === 0) {
    return (
      <div className="surface execution-log" aria-label="Execution log">
        <h3 className="execution-log__title">Execution log</h3>
        <p className="execution-log__empty">No log entries.</p>
      </div>
    );
  }

  return (
    <div className="surface execution-log" aria-label="Execution log">
      <h3 className="execution-log__title">Execution log</h3>
      <div className="execution-log__entries">
        {entries.map((entry) => (
          <div key={entry.id} className="execution-log__entry">
            <span className="execution-log__time mono">{entry.time ? new Date(entry.time).toISOString() : "—"}</span>
            <span className="execution-log__level mono" data-tone={entry.level === "error" ? "sear" : entry.level === "warn" ? "ember" : "dim"}>
              {entry.level.toUpperCase()}
            </span>
            <p className="execution-log__message">{entry.message}</p>
          </div>
        ))}
      </div>
      {onLoadMore && (
        <button type="button" className="btn btn-ghost execution-log__loadmore" onClick={onLoadMore}>
          Show more
        </button>
      )}
    </div>
  );
}
