import { text } from "./ops";

/**
 * What the Arena page is allowed to say.
 *
 * `/arena` was a 404 for the whole life of the v2 law: the contracts are deployed beside the
 * legacy escrow (ADR-0011), the API projects them at `GET /arena` whenever `ARENA_ADDRESS` is
 * set, and no page read any of it. So the second fee schedule — 15%, sponsor-paid at posting,
 * refunded on four of eight outcomes — was a constant in a JSON file while the site published
 * only the legacy 5%.
 *
 * The API already distinguishes the two empty-looking cases, and this keeps them apart at the
 * surface as well: `projected: false` means *nobody is indexing an arena here*, which is a fact
 * about this host; `projected: true` with zero trials means an arena with nothing in it. One
 * sentence each, and neither is allowed to print a number it did not read.
 */

export type ArenaView =
  | { kind: "unread"; detail: string }
  | { kind: "not-projected"; reason: string }
  | { kind: "empty"; detail: string }
  | { kind: "list"; count: number; rows: { id: string; state: string; reward: string }[] };

type AnyRecord = Record<string, unknown>;

function rows(trials: unknown): { id: string; state: string; reward: string }[] {
  if (!Array.isArray(trials)) return [];
  return trials.map((t) => {
    const r = (t ?? {}) as AnyRecord;
    return {
      id: text(r.id as number | string | undefined),
      // The projection's own vocabulary is not this page's to invent: `state` then `status`,
      // and an em dash when neither arrived. Rendering "unknown" as a status would be a claim.
      state: text((r.state ?? r.status) as string | undefined),
      reward: text((r.rewardEth ?? r.reward) as string | undefined),
    };
  });
}

export function arenaView(payload: unknown): ArenaView {
  if (!payload || typeof payload !== "object") {
    return { kind: "unread", detail: "The arena projection was not read." };
  }
  const body = payload as AnyRecord;
  const meta = (body.meta ?? {}) as AnyRecord;
  const data = (body.data ?? {}) as AnyRecord;

  if (meta.projected === false) {
    return {
      kind: "not-projected",
      reason: typeof meta.reason === "string" ? meta.reason : "this host has no arena address",
    };
  }
  const list = rows(data.trials);
  if (list.length === 0) {
    return {
      kind: "empty",
      detail: "The arena is being read on this host, and it holds no trials yet.",
    };
  }
  return { kind: "list", count: list.length, rows: list };
}
