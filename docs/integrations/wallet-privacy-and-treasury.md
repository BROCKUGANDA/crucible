# Wallet, sponsor funding, treasury custody and privacy

**Reviewed:** 2026-11-05  
**Scope:** Crucible legacy EVM escrow (native ETH), Bitget/Coinbase wallet UX, and Human.tech integration fit.  
**Status:** Architecture decision support. No production wallet credentials, treasury address or vendor secrets are stored here.

## 1. Separate the money flows

These are different roles and must not be conflated.

| Flow | Who signs | What moves | Destination |
|---|---|---|---|
| Sponsor creates a trial | Sponsor's connected wallet | Full reward in native ETH as `msg.value` | CrucibleTrials escrow |
| Agent or skeptic takes an action | Their connected wallet | Bond or skeptic stake where required | CrucibleTrials escrow |
| Protocol fee accrues | Contract settlement | Existing 5% fee on a paid verdict, deducted from agent payout; slash paths follow their own contract allocation | Immutable `treasury()` address |
| Company collects treasury credit | Treasury Safe itself | `withdraw()` called by the Safe | Same Treasury Safe address |

The sponsor does **not** transfer the commission to an operator wallet at trial creation. A sponsor deposits the full trial reward. The contract applies the existing allocation when the trial settles. The v1 fee is 500 bps (5%); do not change it as part of a wallet integration.

The current `withdraw()` function has no arbitrary destination parameter. It pays `credit[msg.sender]` to `msg.sender`. Therefore the approved Treasury Safe must itself call `withdraw()`; a personal Bitget or Coinbase EOA cannot withdraw a Safe's credit.

## 2. Custody model

Use two separate company Safe contracts:

- **Treasury Safe**: set as `TREASURY_ADDRESS` at deployment. It receives protocol credits.
- **Owner Safe**: set as `OWNER_SAFE_ADDRESS` at deployment. It controls owner-only configuration operations.

The address stored in the escrow is immutable in this deployment design. Select and verify the Safe before deployment; do not deploy to a personal EOA expecting to change it later.

Bitget Wallet and Coinbase Wallet can be used as signing wallets for their own transactions and, subject to the Safe's supported signer configuration, as individual Safe owner signers. They are not substitutes for the Safe contract address. The preferred operational pattern is a company Safe with independent hardware-backed signers and an approved threshold; no seed phrase or private key should enter Crucible.

The web app, API, indexer, runner and grader remain keyless. They may prepare transaction data and read chain state, but the user or Safe must approve and sign through their wallet.

## 3. Wallet connector support

- Coinbase Wallet is already supported by the existing Wagmi connector.
- The companion Bitget feature PR detects Bitget's explicit EVM provider namespace, `window.bitkeep.ethereum`, and registers it as a dedicated Wagmi connector. It does not assume Bitget owns `window.ethereum`.
- When RainbowKit is configured, Bitget is added to the wallet picker alongside Safe, MetaMask, Rainbow, Base, WalletConnect and injected-wallet options.
- Without a WalletConnect project id, Bitget is presented as a separate connect action.
- The current app's configured networks are Anvil and Sepolia. Adding a connector is not evidence of a production deployment or support for any other chain.

Wallet support never means Crucible can see a wallet's seed phrase or private key. The wallet signs the EIP-1193 transaction; Crucible receives the public address and transaction result.

## 4. Human.tech WaaP: useful future embedded-wallet option

WaaP is an embedded wallet/authentication experience that can expose an EIP-1193 provider to a dApp and can be wrapped as a Wagmi connector. It could improve onboarding for users who prefer email, phone or social login instead of installing a browser extension.

Human.tech documents a Wagmi connector pattern and a session-protection model. This is valuable for protecting embedded-wallet sessions and signing context. It does **not** make public EVM transactions confidential: once a sponsor creates a trial, the sponsor address, amount, contract call and transaction history remain observable on the selected public chain.

Human.tech's Gas Tank is also a separate feature:
- It can pay eligible network gas for an allowlisted transaction.
- It is funded by the application/project.
- The user still approves the transaction they are signing.
- It does not fund a trial reward, change the sponsor's `msg.value`, receive Crucible commissions, or give Crucible custody of the user's wallet.
- Human.tech's current guide says testnet transactions are never sponsored. Crucible's current Anvil/Sepolia development configuration therefore cannot use the project Gas Tank.
- On supported ETH-native EVM mainnets, eligibility requires both the exact requesting origin and the transaction's outer `to` target to be allowlisted for that chain. A project tank is funded separately.
- The current guide says only 90% of a gross ETH tank balance is spendable on gas (10% fee). Budget this separately from trial rewards and the Crucible settlement fee.

A production WaaP integration should be a separate PR after the SDK version, licence, data-processing terms, allowed login methods, supported chains, origin restrictions, recovery model, rate limits and software supply-chain posture have been reviewed. Use the vendor-supported SDK and a reviewed connector pattern; do not copy an example connector with debug logging or broad personal-data methods into production. The app should request only the wallet address and transaction capability needed; it should not request email or identity credentials for ordinary trial sponsorship.

Useful vendor references:
- [WaaP for apps — start](https://docs.waap.human.tech/for-apps/start)
- [WaaP documentation](https://docs.waap.human.tech/)
- [Human.tech wallet](https://human.tech/wallet)

## 5. Clean SDK and Shield are not a drop-in for v1

Human.tech Clean SDK and Shield are privacy-oriented products associated with private/gated flows on the Aztec ecosystem. The currently documented Shield flow is USDC-focused and applies its own screening and fee model. That does not match Crucible v1, whose trial escrow is native ETH on its configured EVM chain.

Do not:
- route native ETH through an unrelated token bridge;
- add USDC to the existing legacy escrow;
- imply EVM sponsor transactions become private by connecting WaaP;
- mix Shield's fee with Crucible's 5% protocol fee.

A Clean SDK / Shield product needs a distinct architecture decision and likely a separate contract path: asset support, custody and exit semantics, chain finality, identity screening, fee disclosure, privacy/legal obligations, bridge risks and incident recovery must all be specified and independently reviewed. It is not part of the Bitget connector change.

Vendor references:
- [Clean SDK](https://human.tech/clean-sdk)
- [Human.tech Shield](https://human.tech/shield)

## 6. Public-chain visibility and privacy boundary

For native-ETH EVM trials, assume these facts are public:
- wallet addresses and their public transaction history;
- the fact that a sponsor funded a specific contract interaction;
- value transferred to the escrow;
- settlement/withdrawal events and the public treasury address.

A private app page can restrict what the interface displays, but it cannot hide information already published on-chain. Use least-data collection, avoid collecting emails for basic wallet use, do not log signatures or personal information unnecessarily, and never claim that a public-chain transaction is private.

Treasury controls are about **who can sign**, not whether the treasury address is secret. Use a Safe threshold and signer policy, independent review and key separation.

## 7. Required production setup and proof

Before any real-value launch:

1. Create the Treasury Safe and Owner Safe on the exact target chain.
2. Verify each Safe's deployed address, owners, threshold and enabled modules/guards from chain data.
3. Approve the addresses through a second independent channel and record only public addresses and evidence.
4. Deploy the escrow with the reviewed `TREASURY_ADDRESS` and `OWNER_SAFE_ADDRESS`.
5. Read `treasury()` and `owner()` back from the deployed contract and compare them to the approved manifest.
6. Run a small sponsor-funded test trial with test ETH first.
7. Settle it, verify the precise credit and conservation invariant, then execute `withdraw()` through the Treasury Safe's own Safe transaction flow.
8. Reconcile the Safe's incoming transaction to the on-chain `Withdrawn` event.
9. Verify that no application server, browser bundle, log, API, runner or indexer contains any private key or seed phrase.
10. Complete independent audit, legal, monitoring, signer and operational signoffs before mainnet exposure.

No real treasury address or signer credentials belong in source control. No production secret belongs in a `NEXT_PUBLIC_*` variable.

## 8. Decision

**Proceed now:** retain Coinbase support and add the explicit Bitget EVM connector.

**Keep separate:** WaaP is a reasonable future embedded-wallet option but needs vendor/legal/supply-chain review and browser E2E verification before its SDK is added. Clean SDK/Shield is a separate privacy/asset design, not part of current v1.

**Do not ship:** any change that diverts commission to the currently connected personal wallet, changes the 5% fee, accepts a different v1 asset, or claims that on-chain sponsor transactions are private.
