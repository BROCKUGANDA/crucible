// sol-demo.mjs — Solana Mainnet via Alchemy Node RPCs
import 'dotenv/config';

const RPC = process.env.ALCHEMY_SOLANA_RPC_URL;
if (!RPC) {
  console.error('ALCHEMY_SOLANA_RPC_URL is not set in .env');
  process.exit(1);
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'rpc error');
  return json.result;
}

const AGENT_WALLET = '6vrDXjLgksbKbWkfq6zt5S7F6zjNxyjo8c1oKYLYJj4u';

async function main() {
  console.log('Alchemy Solana Mainnet RPC demo');
  console.log('Endpoint:', RPC.replace(process.env.ALCHEMY_API_KEY, '***'));

  const version = await rpc('getVersion');
  console.log('solana version:', version);

  const slot = await rpc('getSlot');
  console.log('current slot:', slot);

  const balance = await rpc('getBalance', [AGENT_WALLET]);
  console.log('agent wallet:', AGENT_WALLET);
  console.log('balance (lamports):', balance?.value);

  const airdropSig = await rpc('requestAirdrop', [AGENT_WALLET, 1_000_000_000]).catch((e) => {
    console.log('airdrop not available on mainnet (expected):', e.message);
    return null;
  });
  if (airdropSig) console.log('airdrop sig:', airdropSig);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
