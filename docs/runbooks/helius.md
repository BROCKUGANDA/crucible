# Helius server configuration — release blocked

The public health route validates configuration only. A separate server-side
operator CLI now implements bounded read-only RPC/WSS verification. Neither path
activates a Solana indexer, executes transactions or replaces the EVM transport.

## Credential boundary

- Revoke/rotate the credential previously shared in chat before any operator use.
  This work neither reads nor rotates a provider account credential.
- Supply the replacement as `HELIUS_API_KEY` in the API process environment only,
  using the operator's secret manager. Never use a browser build variable, commit
  a credential, log resolved endpoints, or put a credential in a request URL to this API.
- `resolveHeliusConfig` in `apps/api/src/helius.ts` derives fixed HTTPS and WSS
  `mainnet.helius-rpc.com` endpoints. It accepts only nonempty ASCII letters,
  digits, underscores and hyphens, at most 256 characters. Syntax is not provider
  authentication. Endpoint overrides (`HELIUS_RPC_URL`, `HELIUS_WS_URL`) and
  `NEXT_PUBLIC_HELIUS_API_KEY` are refused, including empty override values.
- No compose, deployment, browser configuration or secret files were changed.
  An operator must explicitly arrange API-only environment injection after review.

## Read-only health

`GET /v1/integrations/helius/health` on the API returns `200` for valid local
configuration and `503` otherwise, with `Cache-Control: no-store`. It exposes
neither URLs nor credentials. It does **not** make a provider request, verify a
genesis hash, authenticate the key, check quota, or establish a WebSocket.
Both connection states remain `unverified`; financial operations remain disabled
for this integration. This is not a global financial-readiness verdict.

Offline verification from the repository root:

```powershell
node node_modules\vitest\vitest.mjs run apps/api/test/helius.test.ts apps/api/test/helius-probe.test.ts apps/api/test/app.test.ts
npm run typecheck -w @crucible/api
```

Before implementation the new suite failed to import the missing module. Bypassing
all three configuration guards produced 14 failures, covering absent/malformed
credentials, unsupported overrides and the mounted route's refusal. This is a
combined mutation, not exhaustive independent mutation coverage. The length bound,
network prohibition, redaction and success response have assertions but were not
individually mutation-proven. No live RPC/WS verification was attempted.

## Explicit operator-only transport probe

`apps/api/src/helius-probe.ts` uses server `fetch` and the already installed `ws`
runtime (resolved with Node's `createRequire`; no dependency upgrades). The operator
runtime must include that existing dependency. The CLI reads only the supplied
process environment; it does not load dotenv or any credential file.

From the repository root, this command refuses without contacting a provider
(exit code 2):

```powershell
node node_modules\tsx\dist\cli.mjs apps\api\src\helius-cli.ts
```

**Do not run live with the compromised credential.** Only after revocation,
rotation, secure server-process environment injection and separate operator
authorization, use this command (documented, not executed in this work):

```powershell
node node_modules\tsx\dist\cli.mjs apps\api\src\helius-cli.ts --live
```

Only exactly `--live` is accepted; no method, URL, payload, treasury, wallet or
timeout CLI options exist. The production path derives both TLS URLs from the
same fixed host using the existing configuration guards. HTTPS redirects and WSS
redirects are forbidden. This is not a public HTTP probe endpoint, and the health
route remains configuration-only. Protect shell/process tracing: never log URLs
or credentials outside this code either.

One invocation performs, sequentially:

1. `getGenesisHash`, requiring the full 44-character Solana mainnet genesis hash
   `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. The 32-character CAIP-2 reference
   is not a valid `getGenesisHash` response and is rejected.
2. `getSlot`, requiring a nonnegative safe integer.
3. One WSS `slotSubscribe`, requiring an integer subscription ID, followed by an
   actual matching `slotNotification` with valid integer slot/parent/root ordering.
4. `slotUnsubscribe` for that ID, requiring a matching `true` acknowledgement.
5. Socket close and forced termination, including on failure or timeout.

All stages share one 10-second deadline; there are no retries or resubscriptions.
HTTP response bodies and WSS messages are limited to 16 KiB, JSON-RPC version and
request IDs are checked, and provider error bodies/messages never enter summaries.
Failures abort HTTP, remove socket listeners and close/terminate the socket. If a
subscription ID is known, failure cleanup attempts one unsubscribe before closing;
an acknowledgement is not guaranteed after disconnect/timeout. Termination ensures
the connection cannot remain live waiting for a close handshake. No subscription
is retained by this process. No transactions, signatures or funds movement exist.

Exit 0 means both reads and the notification/unsubscribe sequence succeeded;
exit 1 means a fixed secret-free failure summary. Successful output contains only
network and the two observed slots, not a financial-readiness verdict. A timeout
does not prove provider outage; quota, auth and network failures intentionally
share coarse summaries. RPC identity does not independently attest WSS genesis;
WSS uses the same fixed mainnet provider hostname, not a separate chain identity call.

Offline injected-transport tests exercise the real probe state machine, including
missing notifications/acks, malformed RPC/WSS responses, HTTP abort, unsubscribe,
listener removal, socket close/termination and redaction. These are controlled
fixtures, not live measurements. Disabling genesis validation and omitting forced
termination together caused two targeted failures (different-genesis refusal and
no-ack timeout resource cleanup); both mutations were restored. Other branches
have assertions but have **not** each been independently mutation-proven.

Final focused validation: 180 tests passed across the Helius configuration,
transport/CLI and API app suites; API typecheck and build passed. Two loopback-only
tests use the installed `ws` runtime and assert the actual server connection set
is empty and the client is closed after success or notification timeout. The CLI
was also executed without flags and refused with exit 2. The IDE build service
was unavailable (`127.0.0.1:64342`); the CLI TypeScript build succeeded instead.

**Live RPC authentication, WSS connectivity and actual mainnet slots remain
unverified.** No rotated valid key was configured, and no `--live` command was run.

## Treasury addresses are candidates, not custody evidence

User-supplied public candidates, recorded here only (not installed as payout defaults):

| Network | Candidate | Authority status |
|---|---|---|
| Ethereum | `0x9cb57c0dAF38462447509998647eD06488CBeBf8` | Unverified; not attested as a Safe |
| Solana | `FzTU9xbifKJUKfigi7LvAsmm3vCtxSLcw9SuPrAoY6Uq` | Unverified; not attested as a multisig |

No account ownership, deployed code, signer threshold, balance or ability to
receive/withdraw protocol credit has been checked. Do not send funds or interpret
a syntactically plausible address as verified custody. Ethereum Safe evidence
does not validate Solana custody.

## Source authority and mandatory handoff

`AGENTS.md` gives code, tests and `crucible-contracts/docs/contract-spec.md`
precedence over external descriptions. Existing `docs/runbooks/mainnet.md`,
`docs/runbooks/treasury-security.md`, `SECURE_RELEASE_CHECKLIST.md` and the
fail-closed `apps/api/src/mainnet-readiness.ts` remain applicable and unchanged.
The runbooks contain historical deployment statements; reading them is not proof
of current on-chain state or sign-off validity. No production sign-offs were changed.

Release requires the mandatory parent join with the concurrent runtime/AAS work,
review of the exact combined diff, offline gates and separately authorized live
connectivity/custody verification. Do not run deployment, promotion, mainnet
preflight network probes, trades, wallet approvals, or treasury transfers as part
of this slice. No release approval is implied by a green configuration response.