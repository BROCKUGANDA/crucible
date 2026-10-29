/**
 * The sponsorship queue.
 *
 * A sponsorship application is a request for test ETH from the funder. Today
 * every one of them ended at the funder's answer and nowhere else: the wallet
 * that asked was told "granted" or "refused", and the operator who owns the
 * treasury was never told that anyone had asked at all. That is the gap this
 * closes - an application is an event the owner is entitled to hear about.
 *
 * Every application is recorded, **granted or refused**. A refusal is not a
 * non-event: "a wallet asked and the policy said no" is exactly what an
 * operator needs to see, and a queue that only holds the successes would say
 * "nothing happened" when something did.
 *
 * In-memory (ADR-0008), like the rest of this host's state: a restart empties
 * the queue, which is acceptable for a demo funder whose own ledger is
 * in-memory too. It is bounded for the reason the dead-letter queue is
 * bounded - a queue that grows without limit is a second outage wearing the
 * first one's clothes. A hundred recent applications is the window that
 * matters; the whole history belongs to whatever ships logs off-box.
 */

/**
 * How an application ended.
 *
 * `granted` - the funder said yes and the ETH went.
 * `refused` - the funder said no, and said why.
 * `unanswered` - nobody answered: no funder on this host, or the funder could
 *   not be reached, or it answered with nothing readable. It is not a refusal,
 *   and reporting it as one would tell the operator "the policy said no" when
 *   the truth is "the request never got asked".
 */
export type SponsorshipOutcome = "granted" | "refused" | "unanswered";

export interface SponsorshipApplication {
  /** Monotonic within this process, so two applications can be told apart. */
  id: number;
  /** The wallet that asked, lowercased. */
  wallet: string;
  /** What it asked for, as the decimal string the request carried. */
  requestedEth: string;
  /** What it got, or null when it got nothing. Null is unknown, never zero. */
  grantedEth: string | null;
  outcome: SponsorshipOutcome;
  /** Why it was refused, or why the funder could not be reached. */
  reason: string | null;
  /** Epoch milliseconds. */
  at: number;
}

/** How many applications are kept. */
export const SPONSORSHIP_QUEUE_CAP = 100;

/** The wall clock, injected so a test can say when an application arrived. */
export type Clock = () => number;

export class SponsorshipQueue {
  private readonly entries: SponsorshipApplication[] = [];
  private readonly now: Clock;
  private nextId = 1;

  constructor(opts: { now?: Clock } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record an application and hand back the stored record.
   *
   * The stored record is what the owner is shown, so it is the one with the id
   * and the timestamp on it - not the caller's copy, which has neither.
   */
  record(input: {
    wallet: string;
    requestedEth: string;
    grantedEth: string | null;
    outcome: SponsorshipOutcome;
    reason: string | null;
  }): SponsorshipApplication {
    const application: SponsorshipApplication = {
      id: this.nextId++,
      wallet: input.wallet.toLowerCase(),
      requestedEth: input.requestedEth,
      grantedEth: input.grantedEth,
      outcome: input.outcome,
      reason: input.reason,
      at: this.now(),
    };
    this.entries.push(application);
    // The oldest falls off the front. `splice` on a hundred entries is not a
    // performance problem; a queue that never forgets is.
    while (this.entries.length > SPONSORSHIP_QUEUE_CAP) this.entries.shift();
    return application;
  }

  /** Every retained application, newest first. */
  list(): SponsorshipApplication[] {
    return [...this.entries].reverse();
  }

  /** How many applications are retained. */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * The owner gate.
 *
 * The queue is the operator's view of who asked for the treasury's test ETH, so
 * it is not a public list. `owners` is the set of wallets allowed to see it.
 *
 * **What this gate does and does not prove.** It compares the address the
 * caller claims with the configured owner list. A caller who is not the owner
 * gets nothing; a caller who *claims* to be the owner is believed. That is
 * enough for a demo host whose queue holds applicant addresses and amounts -
 * data the applicants themselves can see - and it is not enough for a real
 * deployment, where the production gate is a signature from the owner's wallet
 * (or a session), not a claimed address. The distinction is written here
 * because a gate that looks stronger than it is is worse than no gate.
 */
export class OwnerGate {
  private readonly owners: Set<string>;

  constructor(owners: readonly string[] = []) {
    this.owners = new Set(owners.map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0));
  }

  /** True when this host has any owner configured at all. */
  get configured(): boolean {
    return this.owners.size > 0;
  }

  /** The configured owners, lowercased. */
  list(): string[] {
    return [...this.owners];
  }

  /** True when `wallet` is one of the configured owners. */
  isOwner(wallet: string): boolean {
    return this.owners.has(wallet.trim().toLowerCase());
  }
}

/**
 * The one line an operator reads when somebody asks for test ETH.
 *
 * Plain words, no jargon, and the figure that matters: how much was asked for
 * and how much went. "0.05 ETH" rather than "50000000000000000 wei" - the
 * queue is read by a person, not a parser.
 */
export function sponsorshipMessage(a: SponsorshipApplication): string {
  if (a.outcome === "granted") {
    return `Sponsorship application: ${a.wallet} asked for ${a.requestedEth} ETH and was granted ${a.grantedEth ?? "an unknown amount"} ETH.`;
  }
  if (a.outcome === "unanswered") {
    return `Sponsorship application: ${a.wallet} asked for ${a.requestedEth} ETH and nobody answered${a.reason ? ` (${a.reason})` : ""}.`;
  }
  return `Sponsorship application: ${a.wallet} asked for ${a.requestedEth} ETH and was refused${a.reason ? ` (${a.reason})` : ""}.`;
}
