"use client";

/**
 * DataTable — an accessible, sortable, paginated data table.
 *
 * Uses semantic table markup with proper header/scope associations, zebra
 * striping, and responsive scroll wrapper. The parent supplies columns, rows,
 * and an onSort handler. Bounded — the parent controls pagination.
 */
type Column = {
  key: string;
  label: string;
  sortable?: boolean;
  numeric?: boolean;
};

type Row = Record<string, string | number>;

export function DataTable({
  columns,
  rows,
  onSort,
  sortedBy,
  sortDir,
}: {
  columns: Column[];
  rows: Row[];
  onSort?: (key: string) => void;
  sortedBy?: string;
  sortDir?: "asc" | "desc";
}) {
  if (rows.length === 0) {
    return (
      <div className="scroll-x" aria-label="Data table">
        <table className="data-table" role="grid" aria-rowcount="0">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={columns.length} className="data-table__empty">
                No results.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="scroll-x" aria-label="Data table">
      <table className="data-table" role="grid" aria-rowcount={rows.length}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                onClick={c.sortable ? () => onSort?.(c.key) : undefined}
                role="button"
                aria-sort={sortedBy === c.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                className={c.sortable ? "data-table__sortable" : undefined}
              >
                {c.label}
                {sortedBy === c.key && (sortDir === "asc" ? " ▲" : " ▼")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} role="row">
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? "data-table__numeric" : undefined}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
