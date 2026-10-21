# Runbook: incident response

## First

1. **Contain, do not improvise.** For a live site or escrow issue, stop the
   bleeding with the smallest reversible action (disable the voice key, unwire
   an optional registry, roll back a deploy). Do not "fix" balances by sending
   funds.
2. **Preserve evidence.** Capture the transaction hash, block number, API
   `/health` and `/ready`, container logs, and the host crontab before changing
   anything.
3. **Report privately.** Use the contact in [`SECURITY.md`](../../SECURITY.md).
   Do not open a public issue for an exploitable bug.

## Key compromise

| Key                      | What a compromise reaches                                                            | Immediate action                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Deployer / owner         | Can rewire the optional reputation/identity registries; cannot move escrow or settle | Unwire if malicious wiring is suspected; rotate owner via a new deployment on a real chain. |
| Keeper                   | Permissionless sweep actions only                                                    | Rotate `KEEPER_PRIVATE_KEY`; no escrow authority is lost.                                   |
| Agent operator           | Its own free stake and claims                                                        | Unstake/withdraw what remains; rotate the runner key with `setRunner`.                      |
| Runner key               | Can sign a run for its agent until `sigDeadline`                                     | `setRunner` to a new key; a signed run is bound to the trial/agent/hash/deadline.           |
| Argus seat               | Can vote on disputes while the seat set is live                                      | The seat set is constructor-fixed; a compromised seat is a redeploy decision.               |
| ElevenLabs TTS           | Spends TTS credits; no chain access                                                  | `VOICE_DISABLED=1`, recreate API, revoke the key.                                           |
| WalletConnect project id | Public by design; no custody                                                         | Rotate in WalletConnect Cloud if abused.                                                    |

## Contract bug or stuck funds

There is **no pause, no upgrade and no admin recovery**. The owner cannot move
escrowed ETH, a bond or a break stake. Options are limited to:

- Let the state machine finish (`finalize`, `reclaimExpired`) where the rules
  allow.
- For a logic bug, deploy a fixed contract and migrate by community decision;
  the old escrow's funds remain governed by the old code.
- Preserve all evidence and publish a post-mortem; do not quietly patch state.

## Provider / infrastructure incident

- **Edge 502:** [site-down.md](site-down.md).
- **Indexer empty/oscillating:** [indexer-stalled-or-reset.md](indexer-stalled-or-reset.md).
- **Voice provider down:** [voice-host.md](voice-host.md); the UI should remain
  silent and usable.
- **Registry (ERC-8004) down:** settlement is designed to proceed; reputation
  is backfillable. Confirm the verdict landed and backfill later.

## After

- Write down what changed, what was observed, and what remains open.
- Add a regression test for any code fix; the incident is not closed on a
  manual host patch alone.
- Update the relevant runbook, ADR or changelog so the next operator starts
  from the new truth.
