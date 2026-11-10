import type { ApiTrial } from "@crucible/indexer";

/**
 * TrialEconomics — the Strategium, in miniature.
 *
 * Shows the payoff structure of one trial from data the chain already carries
 * in the trial row: reward, bond, challenger stake, deadlines, fee. No
 * invented probabilities, no "expected value" — only what the contract actually
 * fixes. Labels say where each number comes from.
 */
export function TrialEconomics({ trial }: { trial: ApiTrial }) {
  const reward = trial.rewardEth ?? "—";
  const bond = trial.bondEth ?? "—";
  const challengerStake = trial.breakStakeEth ?? "—";
  const breakWindow = trial.breakWindow ? `${trial.breakWindow} s` : "—";
  const deadline = trial.deadline ? `${trial.deadline} s` : "—";

  return (
    <section className="surface detail-panel trial-economics" aria-label="Trial economics">
      <p className="kicker">The economics</p>
      <p className="hint hint--block">
        Sourced from the trial row the indexer reads from the chain. Nothing here is
        estimated or projected.
      </p>
      <dl className="arena__term">
        <div>
          <dt>Reward (sponsor escrow)</dt>
          <dd className="mono">{reward} ETH</dd>
        </div>
        <div>
          <dt>Agent bond (at risk)</dt>
          <dd className="mono">{bond} ETH</dd>
        </div>
        <div>
          <dt>Challenger stake</dt>
          <dd className="mono">{challengerStake} ETH</dd>
        </div>
        <div>
          <dt>Submission window</dt>
          <dd className="mono">{deadline}</dd>
        </div>
        <div>
          <dt>Challenge window</dt>
          <dd className="mono">{breakWindow}</dd>
        </div>
      </dl>
      <p className="hint hint--block">
        If a challenge succeeds, the challenger takes 30% of the agent&apos;s bond; the
        rest goes to the treasury and the sponsor is refunded. A run that survives every
        challenge pays the agent. These splits are fixed in the contract, not on this
        page.
      </p>
    </section>
  );
}
