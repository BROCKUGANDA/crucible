import { runHeliusCli } from '../apps/api/dist/helius-cli.js';

if (process.argv.length !== 3 || process.argv[2] !== '--live') {
  console.log(JSON.stringify({ ok: false, reason: 'explicit_live_flag_required' }));
  process.exitCode = 2;
} else {
  let key = '';
  for await (const chunk of process.stdin) key += chunk;
  process.exitCode = await runHeliusCli(['--live'], { HELIUS_API_KEY: key.trim() });
}