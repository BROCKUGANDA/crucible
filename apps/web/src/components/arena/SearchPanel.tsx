"use client";

import { useState } from "react";

/**
 * SearchPanel — a debounced search input with clear and submit.
 *
 * The parent supplies onSearch. Debouncing is the parent's concern (or this
 * component can manage it). Accessible label, clear action, enter to submit.
 */
export function SearchPanel({
  placeholder = "Search trials",
  onSearch,
  value,
}: {
  placeholder?: string;
  onSearch: (query: string) => void;
  value?: string;
}) {
  const [query, setQuery] = useState(value ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query);
  };

  return (
    <form className="search-panel" onSubmit={handleSubmit} role="search" aria-label="Search">
      <label className="search-panel__label" htmlWith="search-input">
        Search
      </label>
      <input
        id="search-input"
        className="input"
        type="search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button type="submit" className="btn btn-ghost search-panel__submit">
        Go
      </button>
      {query.length > 0 && (
        <button
          type="button"
          className="btn btn-ghost search-panel__clear"
          onClick={() => {
            setQuery("");
            onSearch("");
          }}
        >
          Clear
        </button>
      )}
    </form>
  );
}
