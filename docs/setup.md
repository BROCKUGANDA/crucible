# Crucible — setup for local development

## Prerequisites

- **Node 20+** and npm 10+
- **Foundry** (`forge`, `cast`, `anvil`, `chisel`)

Foundry does not have an official native-Windows installer. Two options:

**WSL2 (recommended for Linux tooling)**

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

**Native Windows (prebuilt binaries)**

Download `foundry_v<version>_win32_amd64.zip` from
<https://github.com/foundry-rs/foundry/releases>, verify the SHA256 against the
published `.sha256`, and extract to a directory on PATH:

```powershell
$ver = "v1.8.5"
$zip = "$env:TEMP\foundry.zip"
curl.exe -L -o $zip "https://github.com/foundry-rs/foundry/releases/download/$ver/foundry_${ver}_win32_amd64.zip"
$expected = (curl.exe -L "https://github.com/foundry-rs/foundry/releases/download/$ver/foundry_${ver}_win32_amd64.sha256") -split '\s+' | Select-Object -First 1
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($expected.Trim() -ne $actual) { throw "checksum mismatch" }
New-Item -ItemType Directory -Force "$env:USERPROFILE\.foundry\bin" | Out-Null
Expand-Archive $zip "$env:USERPROFILE\.foundry\bin" -Force
[Environment]::SetEnvironmentVariable("Path",
  [Environment]::GetEnvironmentVariable("Path","User").TrimEnd(";") + ";$env:USERPROFILE\.foundry\bin", "User")
```

Open a **new** shell afterwards — an already-running shell keeps its old PATH.

## Install

```bash
npm install
```

`forge-std` is vendored under `crucible-contracts/lib` rather than installed as a git
submodule, so a judge can clone and build with no network access.

## Run the demo

```bash
npm run demo
```

Starts Anvil, deploys both contracts, replays sponsor → agent → skeptic → verdict, and
leaves the node running. It prints the deployed addresses.

## Run the stack

```bash
# terminal 1 — API + indexer
TRIALS_ADDRESS=0x… ALLOY_ADDRESS=0x… npm run api:dev

# terminal 2 — web
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 npm run web:dev
```

## Verify

```bash
npm run contracts:test   # 64 Foundry tests
npm test                 # 121 TypeScript tests
npm run build            # tsc + next build
```

## Deploy to Sepolia

```bash
export PRIVATE_KEY=0x…
export SEPOLIA_RPC_URL=https://…
cd crucible-contracts
forge script script/Deploy.s.sol:Deploy --rpc-url sepolia --broadcast
```

`Deploy.s.sol` defaults to Anvil account #0 when `PRIVATE_KEY` is unset, so a local run
needs no configuration at all.
