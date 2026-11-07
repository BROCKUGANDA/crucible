// eth-demo.mjs — Ethereum Mainnet via Alchemy Node RPCs
import 'dotenv/config';

const RPC = process.env.ALCHEMY_MAINNET_RPC_URL;
if (!RPC) {
  console.error('ALCHEMY_MAINNET_RPC_URL is not set in .env');
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

const AGENT_WALLET = '0x6c8666b5fd58b5957f46c4b1c5f76fe65e329cbb';

async function main() {
  console.log('Alchemy Ethereum Mainnet RPC demo');
  console.log('Endpoint:', RPC.replace(process.env.ALCHEMY_API_KEY, '***'));

  const chainId = await rpc('eth_chainId');
  console.log('chainId:', parseInt(chainId, 16));

  const blockNumber = await rpc('eth_blockNumber');
  console.log('latest block:', parseInt(blockNumber, 16));

  const balance = await rpc('eth_getBalance', [AGENT_WALLET, 'latest']);
  console.log('agent wallet:', AGENT_WALLET);
  console.log('balance (wei):', BigInt(balance).toString());
  // Bigint decimal formatting: no floating point, and truncation (not rounding)
  // so the displayed amount can never exceed the actual balance.
  const wei = BigInt(balance);
  const ethWhole = wei / 10n ** 18n;
  const ethFrac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  console.log('balance (ETH):', `${ethWhole}.${ethFrac}`);

  const gasPrice = await rpc('eth_gasPrice');
  console.log('gas price (wei):', BigInt(gasPrice).toString());

  // Alchemy-enhanced: token balances
  const tokenBalances = await rpc('alchemy_getTokenBalances', [AGENT_WALLET]);
  console.log('token balances count:', tokenBalances?.tokenBalances?.length ?? 0);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
