# Key inventory and admin powers

Every key this project uses, and every power an address holds, in one place.
A reader should be able to answer "what could go wrong, and who can make it go
wrong" without reading the contracts.

**The honest scope of this deployment.** The live site runs against a local
Anvil development chain with no real value on it. The keys below are the
*demo* keys: the well-known Anvil accounts, which are worthless outside a
local chain. This inventory is therefore about the *shape* of the trust
model — who holds what, what a compromise reaches, and what has to change
when a real chain is in front of it — not about live funds.

## Keys

| Key | Where it lives | What it signs | If it leaks |
|---|---|---|---|
| `PRIVATE_KEY` | `.env` on the host; never in git | The deployer's transactions: deploying the contracts, funding a trial | On a real chain: the deployer can move its own funds and, if it is still the contract owner, the admin powers below. The contracts are not upgradeable, so this cannot rewrite the escrow — it can still call the admin functions the owner holds. |
| `KEEPER_PRIVATE_KEY` | `.env` on the host; never in git | The Warden's transactions: sweeping expired trials, quenching windows | The keeper can only perform actions the *contract* already permits to anyone. It is a convenience, not a privilege: the same actions are reachable by any funded account, which is what makes the keeper restartable without a key ceremony. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | build argument; public in the browser bundle | Nothing — it identifies the app to WalletConnect's relay | Nothing. It is public by construction and the `.env.example` says so. |
| `NEXT_PUBLIC_*` (chain, addresses, RPC) | build arguments; public in the browser bundle | Nothing | Nothing. These are the addresses a wallet talks to, and the bundle's copy of them is what the `assert-deployment.sh` script compares against the chain. |
| `NVIDIA_API_KEY`, `NIM_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY` | `.env`; used by the live agent | Nothing on-chain — they are model-provider credentials | Someone else's inference budget. No chain access. |
| `ELEVENLABS_API_KEY` | `.env` on the host; used only by the API's optional voice proxy | Nothing on-chain - a text-to-speech credential | Someone else's TTS budget. The browser never receives it; no chain access. `VOICE_DISABLED=1` silences the route without removing the key. |
| `ELEVENLABS_API_KEY` (speech-to-speech) | `.env` on the host; used by the API's speech host to **transcribe** the visitor's speech as well as to speak | Nothing on-chain - a transcription and text-to-speech credential | Someone else's TTS and STT budget. The browser never receives it; no chain access. `STS_DISABLED=1` turns the whole speech host off. The visitor's speech is text on this key before it is text anywhere else, so the exposure is the same shape as the TTS one ADR-0009 refused to take on caller-supplied words — see ADR-0018. |
| `WARDEN_WEBHOOK_URL` | `.env`; used by the keeper's notifications | Nothing on-chain | The webhook endpoint — which is why the URL is treated as a secret even though it is a URL. |
| Anvil dev key #0 | in the source, in `scripts/demo.mjs` and the keeper's default | Transactions on the local chain | Nothing. It is published in Anvil's own documentation and every account derived from it is public. `gitleaks` flags it; `.gitleaks.toml` says why, in writing. |

**No key that controls real funds is committed.** The only plaintext private
keys in the tree are the published Anvil accounts listed above. `gitleaks`
scans the whole git history on every CI run; `.gitleaks.toml` allowlists those
known development keys and the secp256k1 constants, and every other finding
fails the job.

## Roles the contracts hold

| Power | Held by | What it can do | What it cannot do |
|---|---|---|---|
| `owner` (CrucibleTrials) | The deployer, on the demo | `setReputationBridge`, `setIdentityRegistry` — point the escrow at the sink that records outcomes and at the ERC-8004 registry it links identities to | Move escrowed funds. There is no function that lets the owner touch a trial's reward, a bond or a break stake. |
| `treasury` (CrucibleTrials) | The deployer, on the demo | Receives the settlement fee | Anything. It is a destination, not a permission. |
| `forge` (AlloyRegistry) | `CrucibleTrials`, set once at deploy | `recordWin` and `recordSlash` — mint a tier or decay one | Write a tier for an agent that has not settled. The registry only ever learns about outcomes because the escrow reports them. |
| `isArgus` (CrucibleTrials) | Three dispute seats | Commit and reveal a verdict on a disputed trial | Settle an undisputed trial, or settle one a second time. Two of three are needed, and the seats are distinct and non-zero by construction. |
| `forge` (ReputationBridge) | `CrucibleTrials` | Report a win or a slash to the reputation registry | Report an outcome that did not happen. It reports from the escrow's own events. |
| The keeper | `KEEPER_PRIVATE_KEY` | Permissionless sweep and quench actions | Anything privileged. Everything it does, any funded account can do. |

## The one that matters

**No admin can move user funds.** There is no function anywhere in the
contracts that lets an owner, a seat, the treasury or the keeper take ETH
out of a live trial, a pending bond or a break stake. The settlement fee
goes to the treasury; the rest of the reward goes to the worker; the bond
goes back to the agent or is split with a winning skeptic. That is a
property of the code, and the invariant suite proves it — but the property
is also what the live chain is checked against: `assert-deployment.sh`
reads the deployed contract and confirms the ETH it holds covers everything
it owes.

## What changes on a real chain

This is a demo, and the demo's safety comes from the chain being worthless.
Moving to a chain with value changes three things, and they are listed here
so they are not forgotten:

1. **The deployer key stops being the published one.** It becomes a real key,
   in a keystore, and it is handed over or destroyed after the deploy.
2. **The owner becomes a multisig.** `owner` currently holds the two setter
   functions. On a real chain it belongs to a Safe, and the deployer's key
   is not kept.
3. **The Argus seats stop being Anvil accounts.** They become three
   separately-held keys — and the seats are the only path to a disputed
   settlement, so their holders are the committee.
