#!/usr/bin/env node
// One canonical voice: render the tour's narration with the SAME ElevenLabs voice the live
// room speaks in.
//
// The tour was voiced by Windows SAPI (`Microsoft David Desktop` / `Microsoft Zira Desktop`)
// while the voice room speaks through ElevenLabs with ELEVENLABS_VOICE_ID. Two engines, two
// voices, one product — which is why the recording and the room sound like different people.
//
// The narration text is NOT duplicated here. This reads the line table out of
// `make-narration.ps1` (already the single source of the copy) and ignores the `v` field on
// each line, so there is exactly one voice to change and it comes from the environment.
//
//   node scripts/make-narration.mjs --list   # print the plan; no network, no key needed
//   node scripts/make-narration.mjs          # render every line (needs the key + voice)
//
// Output filenames and directory match the table, so `scripts/mix-narration.sh` keeps working.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "scripts", "make-narration.ps1");
const OUT_DIR = join(ROOT, "demo", "narration");

/** Parse `@{ f = "demo-01.wav"; v = "…"; t = "…" }` rows out of the PowerShell table. */
export function lines(source) {
  const found = [];
  for (const m of source.matchAll(/\{\s*f\s*=\s*"([^"]+)"[^}]*?t\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
    found.push({ file: m[1], text: m[2].replace(/\\"/g, '"') });
  }
  return found;
}

/** The one voice, from the environment the live path already reads. */
export function voice(env = process.env) {
  const voiceId = (env.ELEVENLABS_VOICE_ID ?? "").trim();
  const modelId = (env.ELEVENLABS_MODEL_ID ?? "").trim() || "eleven_multilingual_v2";
  const apiKey = (env.ELEVENLABS_API_KEY ?? "").trim();
  return { voiceId, modelId, apiKey };
}

async function render(line, v) {
  // `output_format=wav_44100` keeps the extension the mix script expects; asking for mp3 here
  // would rename every file in a `mix-narration.sh` that probes by extension.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.voiceId)}?output_format=wav_44100`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/wav", "xi-api-key": v.apiKey },
    body: JSON.stringify({ text: line.text, model_id: v.modelId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    // Never echo the key or the URL's query. The status and the provider's message are enough.
    const detail = (await res.text()).slice(0, 200).replace(v.apiKey, "[KEY]");
    throw new Error(`${line.file}: ElevenLabs answered ${res.status} — ${detail}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`${line.file}: ${bytes.length} bytes is not audio`);
  return bytes;
}

async function main() {
  const table = lines(readFileSync(SOURCE, "utf8"));
  const v = voice();
  if (table.length === 0) {
    console.error("no narration lines found in scripts/make-narration.ps1 — refusing to render nothing");
    return 2;
  }

  if (process.argv.includes("--list")) {
    console.log(`voice: ${v.voiceId || "(unset)"} · model: ${v.modelId}`);
    for (const l of table) console.log(`  ${l.file.padEnd(14)} ${l.text.slice(0, 68)}`);
    console.log(`${table.length} lines · one voice · engine: elevenlabs`);
    return v.voiceId ? 0 : 2; // unset voice is a refusal: there is no canonical voice to use
  }

  if (!v.apiKey || !v.voiceId) {
    console.error(
      "ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are both required: the tour must speak in the " +
        "same voice as the room, and that voice lives in the environment, not in this script.",
    );
    return 2;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const l of table) {
    const bytes = await render(l, v);
    writeFileSync(join(OUT_DIR, l.file), bytes);
    console.log(`${l.file}  ${bytes.length} bytes  voice ${v.voiceId}`);
  }
  console.log(`rendered ${table.length} lines in one voice; run scripts/mix-narration.sh next`);
  return 0;
}

main().then((c) => process.exit(c));
