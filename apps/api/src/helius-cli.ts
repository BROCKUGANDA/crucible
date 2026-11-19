import { pathToFileURL } from "node:url";
import { probeHelius } from "./helius-probe.js";

export async function runHeliusCli(
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  probe = probeHelius,
): Promise<number> {
  if (args.length !== 1 || args[0] !== "--live") {
    console.log(JSON.stringify({ ok: false, reason: "explicit_live_flag_required" }));
    return 2;
  }
  const result = await probe(env);
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runHeliusCli(process.argv.slice(2), process.env);
}