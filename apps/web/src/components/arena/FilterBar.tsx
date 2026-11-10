"use client";

import { useState } from "react";

type FilterOption = { key: string; label: string; count?: number | null };

/**
 * FilterBar — real filter chips that set state and filter the list.
 *
 * Never renders chips that do nothing. Each option is a real button with
 * aria-pressed, and the selected state is reflected visually.
 */
export function FilterBar({
  options,
  activeKey,
  onChange,
  groupLabel = "Filter",
}: {
  options: FilterOption[];
  activeKey: string | null;
  onChange: (key: string | null) => void;
  groupLabel?: string;
}) {
  const [pressed, setPressed] = useState<string | null>(activeKey);

  return (
    <div className="filter-bar" role="group" aria-label={groupLabel}>
      {options.map((opt) => {
        const selected = pressed === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            className="filter-chip"
            data-selected={selected || undefined}
            aria-pressed={selected}
            onClick={() => {
              const next = selected ? null : opt.key;
              setPressed(next);
              onChange(next);
            }}
          >
            {opt.label}
            {opt.count !== null && opt.count !== undefined ? (
              <span className="filter-chip__count">{opt.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
