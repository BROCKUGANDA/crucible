import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const problems = [];
const notes = [];
function checkParams() {
  let p;
  try { p = JSON.parse(readFileSync('params/crucible.params.json', 'utf8')); } catch { problems.push('params/crucible.params.json unreadable'); return; }
  // The v1 fee is an on-chain constant. The params file is v2 metadata and is
  // deliberately not accepted as evidence about what users will pay.
  try {
    const source = readFileSync('crucible-contracts/contracts/CrucibleTrials.sol', 'utf8');
    if (!/FEE_BPS\s*=\s*500\s*;/.test(source)) problems.push('compiled v1 escrow source does not declare FEE_BPS 500');
  } catch { problems.push('v1 escrow source unreadable'); }
  notes.push('v1 fee source and deployed escrow are checked at FEE_BPS 500');
  if (!(p.reward_floor && p.reward_floor.eth)) problems.push('no ETH reward floor in params');
}
function nonEmptyList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}
function checkSignoff(file, fields) {
  if (!existsSync(file)) { problems.push(file + ' missing'); return; }
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { problems.push(file + ' is not JSON'); return; }
  if (j.signed !== true) problems.push(file + ' is not signed (signed must be true)');
  for (const f of fields) {
    const value = j[f];
    if (['sponsors', 'agents', 'signers', 'dashboards'].includes(f) ? !nonEmptyList(value) : value === undefined || value === null || value === '')
      problems.push(file + ' missing or invalid field ' + f);
  }
  if (file.endsWith('timelock.json') && (typeof j.timelockHours !== 'number' || !Number.isFinite(j.timelockHours) || j.timelockHours < 48))
    problems.push(file + ' timelockHours must be a finite number of at least 48');
  if (file.endsWith('genesis-cohort.json') && (!(typeof j.epochCapEth === 'number' || typeof j.epochCapEth === 'string') || Number(j.epochCapEth) <= 0 || !Number.isFinite(Number(j.epochCapEth))))
    problems.push(file + ' epochCapEth must be a positive finite number');
  if (file.endsWith('audit-signoff.json') && (!process.env.DEPLOY_COMMIT || j.commit !== process.env.DEPLOY_COMMIT))
    problems.push(file + ' commit does not match DEPLOY_COMMIT');
}
function checkDeployment() {
  const { MAINNET_RPC_URL: rpc, TRIALS, ALLOY } = process.env;
  if (!TRIALS || !ALLOY) { problems.push('TRIALS and ALLOY are required for deployment assertions'); return; }
  try {
    execFileSync('bash', ['crucible-contracts/scripts/assert-deployment.sh'], { stdio: 'pipe', env: { ...process.env, RPC_URL: rpc, TRIALS_ADDRESS: TRIALS, ALLOY_ADDRESS: ALLOY } });
    notes.push('deployed escrow fee and wiring match the deployment assertions');
  } catch { problems.push('deployed contract assertion failed (including v1 FEE_BPS)'); }
} 
async function checkChain() { 
  const url = process.env.MAINNET_RPC_URL; 
  if (!url) { problems.push('MAINNET_RPC_URL not set'); return; } 
  try { 
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }); 
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.jsonrpc !== '2.0' || j.error || typeof j.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(j.result) || parseInt(j.result, 16) !== 1)
      problems.push('RPC chain id is not a valid mainnet response'); 
    else notes.push('RPC reports chain id 1'); 
  } catch (e) { problems.push('RPC unreachable: ' + e.message); } 
} 
checkParams(); 
checkSignoff('docs/mainnet/audit-signoff.json', ['auditor', 'reportHash', 'commit']); 
checkSignoff('docs/mainnet/legal-signoff.json', ['entity', 'counsel', 'tosVersion']); 
checkSignoff('docs/mainnet/genesis-cohort.json', ['sponsors', 'agents', 'epochCapEth']); 
checkSignoff('docs/mainnet/timelock.json', ['multisig', 'timelockHours', 'signers']); 
checkSignoff('docs/mainnet/monitoring.json', ['oncall', 'alertChannel', 'dashboards']); 
await checkChain();
checkDeployment();
for (const n of notes) console.log('ok: ' + n); 
if (problems.length) { console.error('mainnet preflight FAILED:'); for (const p of problems) console.error('  x ' + p); process.exit(1); } 
console.log('mainnet preflight: all checks pass'); 
