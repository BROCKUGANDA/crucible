import { readFileSync, existsSync } from 'node:fs';

// The preflight is read-only. It must never deploy, sign, transfer or withdraw.
// --signoffs and --params are test overrides only; production defaults are the real tree.
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const SIGNOFF_DIR = String(arg('--signoffs', 'docs/mainnet')).replace(/\/+$/, '');
const PARAMS_FILE = String(arg('--params', 'params/crucible.params.json'));
const problems = [];
const notes = [];
const ZERO = '0x0000000000000000000000000000000000000000';
const SAFE_SELECTORS = {
  treasury: '0x61d027b3',
  owner: '0x8da5cb5b',
  getThreshold: '0xe75235b8',
  getOwners: '0xa0e67e2b',
  getModulesPaginated: '0xcc2f8452',
};
const SAFE_STORAGE = {
  fallbackHandler: '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5',
  guard: '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8',
  moduleGuard: '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947',
};

function loadJson(file, label) {
  if (!existsSync(file)) {
    problems.push(file + ' missing');
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    problems.push(file + ' is not JSON');
    return null;
  }
}

function checkParams() {
  const p = loadJson(PARAMS_FILE, 'params');
  if (!p) return;
  if (p.legacy_fee_bps_v1_frozen !== 500) {
    problems.push('v1 fee is not the canonical 500 (5 percent, ADR-0001)');
  }
  notes.push(
    'v1 fee 500 bps (5 percent); v2 arena fee_bps is ' +
      p.fee_bps +
      ' per ADR-0011, a separate law, not the escrow fee',
  );
  if (!(p.reward_floor && p.reward_floor.eth)) problems.push('no ETH reward floor in params');
}

function checkSignoff(file, fields) {
  const j = loadJson(file, file);
  if (!j) return null;
  if (j.signed !== true) problems.push(file + ' is not signed (signed must be true)');
  for (const f of fields) {
    if (!j[f] || (Array.isArray(j[f]) && j[f].length === 0)) {
      problems.push(file + ' missing field ' + f);
    }
  }
  return j;
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}
function isBytes32(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function normAddress(value) {
  return String(value).toLowerCase();
}
function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}
function chunks(hex) {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length % 64 !== 0) throw new Error('ABI result is not word-aligned');
  const out = [];
  for (let i = 0; i < raw.length; i += 64) out.push(raw.slice(i, i + 64));
  return out;
}
function addressFromWord(value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('invalid ABI address word');
  return '0x' + value.slice(24).toLowerCase();
}
function decodeAddressArray(data) {
  const words = chunks(data);
  if (words.length < 2) throw new Error('getOwners returned truncated ABI data');
  const offset = Number(BigInt('0x' + words[0]));
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) throw new Error('getOwners returned invalid offset');
  const lengthIndex = offset / 32;
  if (lengthIndex >= words.length) throw new Error('getOwners returned invalid array offset');
  const length = Number(BigInt('0x' + words[lengthIndex]));
  if (!Number.isSafeInteger(length) || length > 100 || lengthIndex + 1 + length > words.length) {
    throw new Error('getOwners returned invalid array length');
  }
  return words.slice(lengthIndex + 1, lengthIndex + 1 + length).map(addressFromWord);
}
function decodeModules(data) {
  const words = chunks(data);
  if (words.length < 3) throw new Error('getModulesPaginated returned truncated ABI data');
  const offset = Number(BigInt('0x' + words[0]));
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) throw new Error('module array offset is invalid');
  const lengthIndex = offset / 32;
  if (lengthIndex >= words.length) throw new Error('module array offset is outside return data');
  const length = Number(BigInt('0x' + words[lengthIndex]));
  if (!Number.isSafeInteger(length) || length > 20 || lengthIndex + 1 + length > words.length) {
    throw new Error('module array length is invalid');
  }
  const modules = words.slice(lengthIndex + 1, lengthIndex + 1 + length).map(addressFromWord);
  const next = addressFromWord(words[1]);
  return { modules, next };
}

async function rpcRequest(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(method + ' HTTP ' + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(method + ' RPC error: ' + String(payload.error.message || 'unknown'));
  if (payload.result === undefined || payload.result === null) throw new Error(method + ' returned no result');
  return payload.result;
}

async function checkChain() {
  const urls = [process.env.MAINNET_RPC_URL, process.env.MAINNET_RPC_FALLBACK_URL].filter(Boolean);
  if (!urls.length) {
    problems.push('MAINNET_RPC_URL not set');
    return null;
  }
  let last = 'RPC unreachable';
  for (const url of urls) {
    let host = 'invalid URL';
    try {
      host = new URL(url).host;
    } catch {}
    try {
      const chainId = await rpcRequest(url, 'eth_chainId', []);
      if (BigInt(chainId) === 1n) {
        notes.push('RPC reports chain id 1 (' + host + ')');
        return url;
      }
      last = 'RPC chain id is not 1 (' + host + ')';
    } catch (error) {
      last = 'RPC ' + host + ' unreachable: ' + error.message;
    }
  }
  problems.push(last);
  return null;
}

function checkSafeRecord(record, label) {
  if (!record || typeof record !== 'object') {
    problems.push('treasury.json missing ' + label);
    return false;
  }
  for (const field of ['address', 'singletonAddress']) {
    if (!isAddress(record[field]) || normAddress(record[field]) === ZERO) {
      problems.push('treasury.json ' + label + '.' + field + ' must be a non-zero address');
    }
  }
  if (!isBytes32(record.singletonRuntimeCodeHash)) {
    problems.push('treasury.json ' + label + '.singletonRuntimeCodeHash must be bytes32');
  }
  if (!isBytes32(record.proxyRuntimeCodeHash)) {
    problems.push('treasury.json ' + label + '.proxyRuntimeCodeHash must be bytes32');
  }
  if (!Array.isArray(record.owners) || record.owners.length !== 3 || record.owners.some((x) => !isAddress(x))) {
    problems.push('treasury.json ' + label + '.owners must contain exactly three valid addresses');
  } else {
    const owners = record.owners.map(normAddress);
    if (new Set(owners).size !== owners.length || owners.includes(ZERO)) {
      problems.push('treasury.json ' + label + '.owners contains a duplicate or zero address');
    }
  }
  if (record.threshold !== 2) {
    problems.push('treasury.json ' + label + '.threshold must be 2 for the approved 2-of-3 pilot profile');
  }
  if (!Array.isArray(record.modules) || record.modules.length !== 0) {
    problems.push('treasury.json ' + label + '.modules must be an explicitly reviewed empty array for the initial pilot');
  }
  for (const field of ['guard', 'moduleGuard', 'fallbackHandler']) {
    if (!isAddress(record[field]) || normAddress(record[field]) !== ZERO) {
      problems.push('treasury.json ' + label + '.' + field + ' must be the zero address for the initial pilot');
    }
  }
  return (
    isAddress(record.address) &&
    isAddress(record.singletonAddress) &&
    isBytes32(record.singletonRuntimeCodeHash) &&
    isBytes32(record.proxyRuntimeCodeHash) &&
    Array.isArray(record.owners) &&
    record.owners.length === 3 &&
    record.threshold === 2 &&
    Array.isArray(record.modules) &&
    record.modules.length === 0 &&
    ['guard', 'moduleGuard', 'fallbackHandler'].every(
      (field) => isAddress(record[field]) && normAddress(record[field]) === ZERO,
    )
  );
}

async function checkSafe(url, record, label) {
  if (!checkSafeRecord(record, label)) return;
  try {
    const safeCode = await rpcRequest(url, 'eth_getCode', [record.address, 'latest']);
    if (safeCode === '0x' || safeCode === '0x0') throw new Error(label + ' address has no contract code');
    const proxyCodeHash = await rpcRequest(url, 'web3_sha3', [safeCode]);
    if (normAddress(proxyCodeHash) !== normAddress(record.proxyRuntimeCodeHash)) {
      throw new Error(label + ' proxy runtime code hash mismatch');
    }

    // SafeProxy stores the singleton/master copy at storage slot zero. Verify the proxy
    // points to the exact chain-specific singleton recorded from Safe's canonical deployment
    // registry, then verify that singleton's runtime code hash.
    const singletonWord = await rpcRequest(url, 'eth_getStorageAt', [record.address, '0x0', 'latest']);
    const singleton = addressFromWord(String(singletonWord).replace(/^0x/, '').padStart(64, '0'));
    if (singleton !== normAddress(record.singletonAddress)) {
      throw new Error(label + ' proxy singleton mismatch: expected ' + record.singletonAddress + ', got ' + singleton);
    }
    const singletonCode = await rpcRequest(url, 'eth_getCode', [record.singletonAddress, 'latest']);
    if (singletonCode === '0x' || singletonCode === '0x0') throw new Error(label + ' singleton has no code');
    const codeHash = await rpcRequest(url, 'web3_sha3', [singletonCode]);
    if (normAddress(codeHash) !== normAddress(record.singletonRuntimeCodeHash)) {
      throw new Error(label + ' singleton runtime code hash mismatch');
    }

    const thresholdData = await rpcRequest(url, 'eth_call', [{ to: record.address, data: SAFE_SELECTORS.getThreshold }, 'latest']);
    const thresholdWords = chunks(thresholdData);
    if (thresholdWords.length !== 1 || BigInt('0x' + thresholdWords[0]) !== 2n) {
      throw new Error(label + ' on-chain threshold is not 2');
    }

    const ownersData = await rpcRequest(url, 'eth_call', [{ to: record.address, data: SAFE_SELECTORS.getOwners }, 'latest']);
    const actualOwners = decodeAddressArray(ownersData).map(normAddress).sort();
    const expectedOwners = record.owners.map(normAddress).sort();
    if (actualOwners.length !== expectedOwners.length || actualOwners.some((owner, i) => owner !== expectedOwners[i])) {
      throw new Error(label + ' on-chain owner set differs from treasury.json');
    }

    let start = '0x0000000000000000000000000000000000000001';
    const actualModules = [];
    for (let page = 0; page < 10; page += 1) {
      const data = SAFE_SELECTORS.getModulesPaginated + start.slice(2).padStart(64, '0') + word(20);
      const result = await rpcRequest(url, 'eth_call', [{ to: record.address, data }, 'latest']);
      const decoded = decodeModules(result);
      actualModules.push(...decoded.modules.map(normAddress));
      if (decoded.next === '0x0000000000000000000000000000000000000001') break;
      if (page === 9) throw new Error(label + ' module enumeration exceeded 10 pages');
      start = decoded.next;
    }
    if (actualModules.length !== 0) throw new Error(label + ' has one or more enabled modules');
    for (const [field, slot] of Object.entries(SAFE_STORAGE)) {
      const storage = await rpcRequest(url, 'eth_getStorageAt', [record.address, slot, 'latest']);
      const actual = addressFromWord(String(storage).replace(/^0x/, '').padStart(64, '0'));
      if (actual !== ZERO) throw new Error(label + ' has a non-zero ' + field + ' configuration');
    }
    notes.push(label + ' verified: canonical singleton, runtime hash, 2-of-3 owners, no modules/guard/fallback');
  } catch (error) {
    problems.push(label + ' verification failed: ' + error.message);
  }
}

async function checkEscrow(url, escrow, expectedTreasury, expectedOwner) {
  if (!escrow || typeof escrow !== 'object') {
    problems.push('treasury.json contains an invalid enabled escrow record');
    return;
  }
  if (!isAddress(escrow.address) || normAddress(escrow.address) === ZERO) {
    problems.push('treasury.json escrow address must be a non-zero address');
    return;
  }
  if (!isBytes32(escrow.runtimeCodeHash)) {
    problems.push('treasury.json escrow runtimeCodeHash must be bytes32');
    return;
  }
  try {
    const code = await rpcRequest(url, 'eth_getCode', [escrow.address, 'latest']);
    if (code === '0x' || code === '0x0') throw new Error('escrow address has no contract code');
    const codeHash = await rpcRequest(url, 'web3_sha3', [code]);
    if (normAddress(codeHash) !== normAddress(escrow.runtimeCodeHash)) {
      throw new Error('escrow runtime bytecode hash mismatch');
    }
    const treasuryData = await rpcRequest(url, 'eth_call', [{ to: escrow.address, data: SAFE_SELECTORS.treasury }, 'latest']);
    const ownerData = await rpcRequest(url, 'eth_call', [{ to: escrow.address, data: SAFE_SELECTORS.owner }, 'latest']);
    const actualTreasury = addressFromWord(chunks(treasuryData)[0]);
    const actualOwner = addressFromWord(chunks(ownerData)[0]);
    if (actualTreasury !== normAddress(expectedTreasury)) {
      throw new Error('on-chain treasury() does not equal the approved Treasury Safe');
    }
    if (actualOwner !== normAddress(expectedOwner)) {
      throw new Error('on-chain owner() does not equal the approved Owner Safe');
    }
    notes.push((escrow.name || 'Escrow') + ' verified: bytecode, immutable treasury and owner');
  } catch (error) {
    problems.push((escrow.name || 'Escrow') + ' verification failed: ' + error.message);
  }
}

async function checkTreasury(url, auditSignoff) {
  const file = SIGNOFF_DIR + '/treasury.json';
  const record = checkSignoff(file, [
    'chainId',
    'asset',
    'treasurySafe',
    'ownerSafe',
    'canonicalDeploymentSource',
    'verifiedBy',
    'deploymentCommit',
    'evidenceHash',
  ]);
  if (!record) return;
  if (record.chainId !== 1) problems.push(file + ' chainId must be 1');
  if (
    auditSignoff &&
    record.deploymentCommit &&
    auditSignoff.commit &&
    String(record.deploymentCommit).toLowerCase() !== String(auditSignoff.commit).toLowerCase()
  ) {
    problems.push(file + ' deploymentCommit must match audit-signoff.json commit');
  }
  if (record.asset !== 'native-ETH') problems.push(file + ' asset must be native-ETH');
  if (record.canonicalDeploymentSource && !/^https:\/\/(github\.com\/safe-fndn\/safe-deployments|github\.com\/safe-global\/safe-deployments)\//.test(record.canonicalDeploymentSource)) {
    problems.push(file + ' canonicalDeploymentSource must reference the official Safe deployments repository');
  }
  if (!isBytes32(record.evidenceHash)) problems.push(file + ' evidenceHash must be bytes32');
  if (!record.deploymentCommit || !/^[0-9a-f]{7,40}$/i.test(record.deploymentCommit)) {
    problems.push(file + ' deploymentCommit must be a commit SHA');
  }
  await checkSafe(url, record.treasurySafe, 'Treasury Safe');
  await checkSafe(url, record.ownerSafe, 'Owner Safe');
  if (
    isAddress(record.treasurySafe?.address) &&
    isAddress(record.ownerSafe?.address) &&
    normAddress(record.treasurySafe.address) === normAddress(record.ownerSafe.address)
  ) {
    problems.push(file + ' Treasury Safe and Owner Safe must be distinct addresses');
  }

  const treasuryAddress = process.env.TREASURY_ADDRESS || '';
  if (!isAddress(treasuryAddress) || normAddress(treasuryAddress) !== normAddress(record.treasurySafe?.address)) {
    problems.push('TREASURY_ADDRESS must equal treasury.json treasurySafe.address');
  }
  const ownerSafeAddress = process.env.OWNER_SAFE_ADDRESS || '';
  if (!isAddress(ownerSafeAddress) || normAddress(ownerSafeAddress) !== normAddress(record.ownerSafe?.address)) {
    problems.push('OWNER_SAFE_ADDRESS must equal treasury.json ownerSafe.address');
  }

  if (!record.escrows || typeof record.escrows !== 'object' || !record.escrows.legacyTrials) {
    problems.push(file + ' must contain escrows.legacyTrials');
  }
  const trialsAddress = process.env.TRIALS_ADDRESS || '';
  const legacyRecord = record.escrows && record.escrows.legacyTrials;
  if (trialsAddress) {
    if (!isAddress(trialsAddress) || normAddress(trialsAddress) === ZERO || !legacyRecord || !isAddress(legacyRecord.address)) {
      problems.push('TRIALS_ADDRESS requires a matching treasury.json escrows.legacyTrials record');
    } else {
      if (normAddress(legacyRecord.address) !== normAddress(trialsAddress)) {
        problems.push(file + ' legacyTrials address does not match TRIALS_ADDRESS');
      }
      await checkEscrow(
        url,
        { ...legacyRecord, name: 'CrucibleTrials' },
        record.treasurySafe.address,
        record.ownerSafe.address,
      );
    }
  } else if (legacyRecord && legacyRecord.address) {
    problems.push(file + ' has a deployed legacyTrials address but TRIALS_ADDRESS is unset');
  } else {
    notes.push('new CrucibleTrials deployment inputs pinned; post-deploy escrow assertions are still required');
  }

  const arenaAddress = process.env.ARENA_ADDRESS || '';
  const arenaRecord = record.escrows && record.escrows.arena;
  if (arenaAddress) {
    if (!isAddress(arenaAddress) || !arenaRecord || !isAddress(arenaRecord.address)) {
      problems.push('ARENA_ADDRESS requires a matching treasury.json escrows.arena record');
    } else {
      if (normAddress(arenaRecord.address) !== normAddress(arenaAddress)) {
        problems.push(file + ' arena address does not match ARENA_ADDRESS');
      }
      await checkEscrow(
        url,
        { ...arenaRecord, name: 'Arena' },
        record.treasurySafe.address,
        record.ownerSafe.address,
      );
    }
  } else if (arenaRecord && arenaRecord.address) {
    problems.push(file + ' has an Arena escrow record but ARENA_ADDRESS is unset');
  }
}

checkParams();
const auditSignoff = checkSignoff(SIGNOFF_DIR + '/audit-signoff.json', ['auditor', 'reportHash', 'commit']);
checkSignoff(SIGNOFF_DIR + '/legal-signoff.json', ['entity', 'counsel', 'tosVersion']);
checkSignoff(SIGNOFF_DIR + '/genesis-cohort.json', ['sponsors', 'agents', 'epochCapEth']);
checkSignoff(SIGNOFF_DIR + '/timelock.json', ['multisig', 'timelockHours', 'signers']);
checkSignoff(SIGNOFF_DIR + '/monitoring.json', ['oncall', 'alertChannel', 'dashboards']);
const mainnetRpc = await checkChain();
if (mainnetRpc) await checkTreasury(mainnetRpc, auditSignoff);

for (const note of notes) console.log('ok: ' + note);
if (problems.length) {
  console.error('mainnet preflight FAILED:');
  for (const problem of problems) console.error('  x ' + problem);
  process.exit(1);
}
console.log('mainnet preflight: all checks pass');
