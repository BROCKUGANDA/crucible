#!/usr/bin/env node
/**
 * Render the committed abstention panel ledger into a leaderboard.
 *
 * The ledger is append-only evidence. This script does not measure anything: it only sorts,
 * deduplicates re-runs, and renders the scores that the arena already wrote.
 */
import fs from "node:fs";
import path from "node:path";
import { countRate } from "./panel-format.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const LEDGER = path.resolve(arg("ledger", "grader/results/abstention-panel-2026-10-27.jsonl"));
const OUT = path.resolve(arg("out", "grader/results/abstention-panel-2026-10-27.md"));

function fail(message) {
  console.error(`\nleaderboard: ${message}\n`);
  process.exit(1);
}

function rateValue(rate) {
  return rate === null || rate === undefined ? 1 : rate;
}

function readLedger(file) {
  if (!fs.existsSync(file)) fail(`ledger not found: ${path.relative(process.cwd(), file)}`);
  const rows = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line, i) => ({ line, i: i + 1 }))
    .filter((entry) => entry.line.trim().length > 0)
    .map((entry) => {
      try {
        return JSON.parse(entry.line);
      } catch (err) {
        fail(`${path.relative(process.cwd(), file)}:${entry.i}: invalid JSON — ${err.message}`);
      }
    });
  if (rows.length === 0) fail(`${path.relative(process.cwd(), file)} contains no ledger rows`);
  return rows;
}

const latest = new Map();
for (const entry of readLedger(LEDGER)) {
  if (entry.kind !== "crucible/arena-ledger" || entry.suite !== "abstention") continue;
  if (!entry.row?.abstention) {
    fail(`${entry.model ?? "<unknown model>"} has no abstention score — refusing to render a silent leaderboard`);
  }
  const key = [entry.model, entry.seed, entry.drawHash, entry.suiteEpoch, entry.row.suiteEpoch]
    .filter((v) => v !== undefined && v !== null)
    .join("|");
  const existing = latest.get(key);
  if (!existing || (entry.generatedAt ?? 0) >= (existing.generatedAt ?? 0)) latest.set(key, entry);
}

const entries = [...latest.values()];
if (entries.length === 0) fail(`${path.relative(process.cwd(), LEDGER)} contains no abstention rows`);

entries.sort((a, b) => {
  const ar = a.row.abstention;
  const br = b.row.abstention;
  return (
    rateValue(ar.overconfidentGuesses.rate) - rateValue(br.overconfidentGuesses.rate) ||
    rateValue(ar.answerable.rate) - rateValue(br.answerable.rate) ||
    rateValue(ar.brier) - rateValue(br.brier) ||
    String(a.model).localeCompare(String(b.model))
  );
});

function formatGate(entry) {
  return entry.row.disqualified ? `disqualified: ${entry.row.disqualifyReason}` : "survived";
}

const table = [
  "| Rank | Model | Confident guesses | False abstention | Unanswerable abstention | Brier | Accuracy | p95 | Gate |",
  "|---:|---|---|---|---|---:|---:|---:|---|",
  ...entries.map((entry, index) => {
    const a = entry.row.abstention;
    return [
      index + 1,
      `\`${entry.model}\``,
      countRate(a.overconfidentGuesses.count, a.overconfidentGuesses.n, a.overconfidentGuesses.rate, a.overconfidentGuesses.interval),
      countRate(a.answerable.falseAbstentions, a.answerable.n, a.answerable.rate, a.answerable.interval),
      countRate(a.unanswerable.abstained, a.unanswerable.n, a.unanswerable.rate, a.unanswerable.interval),
      a.brier === null ? "—" : a.brier.toFixed(3),
      `${(entry.row.accuracy * 100).toFixed(1)}%`,
      `${Math.round(entry.row.p95LatencyMs)}ms`,
      formatGate(entry),
    ].join(" | ") + " |";
  }),
];

const provenance = [
  "",
  "## Provenance",
  "",
  "| Model | Seed | Draw hash | Suite epoch | Corpus epoch | Digest |",
  "|---|---|---|---|---|---|",
  ...entries.map((entry) =>
    [
      `\`${entry.model}\``,
      `\`${entry.seed ?? "—"}\``,
      `\`${entry.drawHash?.slice(0, 16) ?? "—"}…\``,
      `\`${entry.suiteEpoch?.slice(0, 16) ?? "—"}…\``,
      `\`${entry.corpusEpoch?.slice(0, 16) ?? "—"}…\``,
      `\`${entry.pinned?.digest?.slice(0, 16) ?? "—"}…\``,
    ].join(" | ") + " |",
  ),
];

const output = [
  "# Abstention panel — live leaderboard",
  "",
  "Sorted by the failure this exam is about: confident guessing first, then false abstention, then",
  "Brier. `n=30` means the model was asked only the probes whose gold is VOID; the 10 controls are",
  "reported separately because abstaining on those is the opposite failure. Disqualification by",
  "p95 is shown next to the score; it does not erase the measurement.",
  "",
  ...table,
  ...provenance,
  "",
].join("\n");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, output);
console.log(`leaderboard: ${entries.length} row${entries.length === 1 ? "" : "s"} → ${path.relative(process.cwd(), OUT)}`);
