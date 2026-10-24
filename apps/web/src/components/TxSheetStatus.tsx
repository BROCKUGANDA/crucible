"use client";

import { formatWei } from "@/lib/eth";

/**
 * TxSheetStatus receipt line (gate 406): "Gas used: 84,213 · 0.000084 ETH".
 * Computed from `gasUsed × effectiveGasPrice` on the receipt, formatted by the one
 * shared ETH formatter. Unknown renders "—" (the project's display law), never 0.
 */
export function TxSheetStatus({
  gasUsed,
  gasWei,
}: {
  gasUsed: bigint | null;
  gasWei: bigint | null;
}) {
  if (gasUsed === null) return null;
  return (
    <p className="hint tx-sheet-status">
      Gas used: {gasUsed.toLocaleString("en-US")} ·{" "}
      {gasWei !== null ? `${formatWei(gasWei, 6)} ETH` : "—"} — gas is the network's toll, not our fee.
    </p>
  );
}