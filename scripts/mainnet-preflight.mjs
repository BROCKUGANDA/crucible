import { readFileSync, existsSync } from 'node:fs'; 
// `--signoffs` and `--params` are test overrides. The defaults are the real tree; the test in
// packages/eval/test/mainnet-preflight.test.ts runs the real unsigned templates for a refusal
// and a fully signed temp directory for a pass, so the gate can be proven in CI without a
// mainnet sign-off existing (which is the state by design).
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const SIGNOFF_DIR = String(arg('--signoffs', 'docs/mainnet')).replace(/\/+$/, '');
const PARAMS_FILE = String(arg('--params', 'params/crucible.params.json'));
const problems = []; 
const notes = []; 
function checkParams() { 
  let p; 
  try { p = JSON.parse(readFileSync(PARAMS_FILE, 'utf8')); } catch { problems.push(PARAMS_FILE + ' unreadable'); return; } 
  if (p.legacy_fee_bps_v1_frozen !== 500) problems.push('v1 fee is not the canonical 500 (5 percent, ADR-0001)'); 
  notes.push('v1 fee 500 bps (5 percent); v2 arena fee_bps is ' + p.fee_bps + ' per ADR-0011, a separate law, not the escrow fee'); 
  if (!(p.reward_floor && p.reward_floor.eth)) problems.push('no ETH reward floor in params'); 
} 
function checkSignoff(file, fields) { 
  if (!existsSync(file)) { problems.push(file + ' missing'); return; } 
  let j; 
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { problems.push(file + ' is not JSON'); return; } 
  if (j.signed !== true) problems.push(file + ' is not signed (signed must be true)'); 
  for (const f of fields) if (!j[f]) problems.push(file + ' missing field ' + f); 
} 
async function checkChain() { 
  // Primary first, then the configured fallback. A public endpoint that answers eth_chainId is
  // not automatically enough for a fork (it may prune), but for this check either one that
  // reports chain id 1 proves the host has a mainnet path. The host is named in the note so a
  // reader knows which endpoint answered.
  const urls = [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_FALLBACK_URL].filter(Boolean); 
  if (!urls.length) { problems.push('MAINNET_RPC_URL not set'); return; } 
  let last = 'RPC unreachable'; 
  for (const url of urls) { 
    let host = 'invalid URL'; 
    try { host = new URL(url).host; } catch {} 
    try { 
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }); 
      const j = await res.json(); 
      if (parseInt(j.result, 16) === 1) { notes.push('RPC reports chain id 1 (' + host + ')'); return; } 
      last = 'RPC chain id is not 1 (' + host + ')'; 
    } catch (e) { last = 'RPC ' + host + ' unreachable: ' + e.message; } 
  } 
  problems.push(last); 
} 
checkParams(); 
checkSignoff(SIGNOFF_DIR + '/audit-signoff.json', ['auditor', 'reportHash', 'commit']); 
checkSignoff(SIGNOFF_DIR + '/legal-signoff.json', ['entity', 'counsel', 'tosVersion']); 
checkSignoff(SIGNOFF_DIR + '/genesis-cohort.json', ['sponsors', 'agents', 'epochCapEth']); 
checkSignoff(SIGNOFF_DIR + '/timelock.json', ['multisig', 'timelockHours', 'signers']); 
checkSignoff(SIGNOFF_DIR + '/monitoring.json', ['oncall', 'alertChannel', 'dashboards']); 
await checkChain(); 
for (const n of notes) console.log('ok: ' + n); 
if (problems.length) { console.error('mainnet preflight FAILED:'); for (const p of problems) console.error('  x ' + p); process.exit(1); } 
console.log('mainnet preflight: all checks pass'); 
