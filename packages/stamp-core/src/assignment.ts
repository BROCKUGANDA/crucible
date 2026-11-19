/**
 * @file assignment.ts — transferring a holder's portion without double counting.
 *
 * The template says the portion follows the instrument and that assignments and
 * transfers do not double count. In practice that means: when an instrument is
 * assigned from one holder to another, the *aggregate* portion for the issuer
 * must not change, and the portion must not appear in both places.
 *
 * The check is on the aggregate, not on the individual instrument: an assignment
 * moves a portion from one row to another. If the sum changes, either the
 * assignment was counted twice or a portion was lost.
 */

export interface AllocationRow {
  instrumentId: string;
  holderId: string;
  /** The effective portion, in base units. */
  portionBaseUnits: bigint;
  /** Whether the row is still the live one for its instrument. */
  active: boolean;
}

export interface Assignment {
  instrumentId: string;
  fromHolderId: string;
  toHolderId: string;
  /** When the assignment took effect. */
  effectiveAt: number;
  /** A legal review reference. */
  reviewRef: string;
}

export interface AssignmentResult {
  rows: AllocationRow[];
  /** The aggregate live portion, in base units. */
  aggregateBaseUnits: string;
  /** Why the assignment was refused, if it was. */
  reason: string | null;
  ok: boolean;
}

/**
 * Apply an assignment.
 *
 * The source row is retired (it stays in the list, inactive, for history) and
 * the portion moves to a row for the new holder. The aggregate is compared
 * before and after: it must be identical.
 */
export function applyAssignment(
  rows: readonly AllocationRow[],
  assignment: Assignment,
): AssignmentResult {
  const before = rows.filter((r) => r.active).reduce((a, r) => a + r.portionBaseUnits, 0n);
  const source = rows.find((r) => r.instrumentId === assignment.instrumentId && r.active);
  if (!source) {
    return {
      rows: [...rows],
      aggregateBaseUnits: before.toString(),
      reason: `no live allocation for instrument ${assignment.instrumentId}`,
      ok: false,
    };
  }
  if (source.holderId !== assignment.fromHolderId) {
    return {
      rows: [...rows],
      aggregateBaseUnits: before.toString(),
      reason: `instrument ${assignment.instrumentId} is held by ${source.holderId}, not ${assignment.fromHolderId}`,
      ok: false,
    };
  }
  const existingTarget = rows.find(
    (r) => r.instrumentId === assignment.instrumentId && r.holderId === assignment.toHolderId && r.active,
  );
  if (existingTarget) {
    // A second live row for the same instrument and holder would double count.
    return {
      rows: [...rows],
      aggregateBaseUnits: before.toString(),
      reason: `instrument ${assignment.instrumentId} already has a live allocation for ${assignment.toHolderId}`,
      ok: false,
    };
  }
  const next: AllocationRow[] = rows.map((r) =>
    r === source ? { ...r, active: false } : r,
  );
  next.push({
    instrumentId: assignment.instrumentId,
    holderId: assignment.toHolderId,
    portionBaseUnits: source.portionBaseUnits,
    active: true,
  });
  const after = next.filter((r) => r.active).reduce((a, r) => a + r.portionBaseUnits, 0n);
  if (after !== before) {
    return {
      rows: [...rows],
      aggregateBaseUnits: before.toString(),
      reason: `assignment changed the aggregate portion (${before} -> ${after})`,
      ok: false,
    };
  }
  return { rows: next, aggregateBaseUnits: after.toString(), reason: null, ok: true };
}

/**
 * Every instrument has at most one live row, and the live rows sum to the
 * recorded aggregate.
 */
export function verifyNoDoubleCount(
  rows: readonly AllocationRow[],
  expectedAggregateBaseUnits: bigint,
): { ok: boolean; reason: string | null } {
  const live = rows.filter((r) => r.active);
  const seen: string[] = [];
  for (const row of live) {
    if (seen.includes(row.instrumentId)) {
      return {
        ok: false,
        reason: `instrument ${row.instrumentId} has more than one live allocation`,
      };
    }
    seen.push(row.instrumentId);
  }
  const total = live.reduce((a, r) => a + r.portionBaseUnits, 0n);
  if (total !== expectedAggregateBaseUnits) {
    return {
      ok: false,
      reason: `live allocations sum to ${total}, the ledger says ${expectedAggregateBaseUnits}`,
    };
  }
  return { ok: true, reason: null };
}