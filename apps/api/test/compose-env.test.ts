import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Every environment variable the API reads is handed to it by the deployment.
 *
 * **What this is for.** A feature whose variable never reaches the container is
 * a feature that is off in production and on in the developer's shell, and the
 * difference is invisible until somebody deploys it. Six such variables were
 * found on 2026-10-29 by reading the two lists side by side: the speech host's
 * `STS_DISABLED` and `ELEVENLABS_STT_MODEL_ID`, the Scribe model's id and kill
 * switch, the sponsorship queue's `CRUCIBLE_OWNER_ADDRESSES`, and
 * `WARDEN_WEBHOOK_URL` — the channel the owner is notified on, so the
 * sponsorship notification could not have left the box that shipped it.
 *
 * **Why a scan and not a list.** A hand-written list of the variables that matter
 * is a list that rots: it names the six that were found and is silent about the
 * seventh, which is the one that breaks next. This reads the API's own source for
 * the names it reads and the deployment's own file for the names it passes, so a
 * variable added to either side without the other is caught here rather than on
 * the box.
 *
 * **How the names are found.** Three forms, all of them real:
 *
 *   * `process.env.NAME` — the direct read.
 *   * `process.env["NAME"]` and `process.env.get("NAME")` — the other two.
 *   * a call to one of the API's own environment readers with a string literal —
 *     `requiredAddress("TRIALS_ADDRESS")`, `requiredPort("PORT", 8787)` and the
 *     rest. The reader names are **found in the source** rather than listed here,
 *     so a new reader is picked up without this file being edited.
 *
 * **What it does not assert.** That compose passes *only* what the API reads: a
 * name the deployment forwards for a sidecar is not a fault. And it does not
 * assert that a variable has a value — compose interpolates every one of them
 * from the host's `.env`, and whether a key is set there is the operator's
 * decision, not the deployment's shape.
 */

/** The API's source, walked rather than listed. */
function apiSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) apiSources(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SRC = join(ROOT, "apps", "api", "src");
const COMPOSE = readFileSync(join(ROOT, "compose.yaml"), "utf8");

/** The names the API's environment readers are called with. */
function readerNames(sources: string[]): { helpers: string[]; names: Set<string> } {
  const helpers = new Set<string>();
  const names = new Set<string>();

  for (const file of sources) {
    const src = readFileSync(file, "utf8");

    // A reader is a function that reaches the environment: either it reads
    // `process.env[name]` itself, or it calls another reader. The second case is
    // why the search repeats — `requiredAddress` reads the environment through
    // `required`, and a scan that only looked for `process.env[name]` would miss
    // every address the deployment has to pass.
    let changed = true;
    while (changed) {
      changed = false;
      const chunks = src.split(/\nfunction /).slice(1);
      for (const chunk of chunks) {
        const name = chunk.match(/^(\w+)/)?.[1];
        if (!name || helpers.has(name)) continue;
        const reads = chunk.includes("process.env[name]");
        const calls = [...helpers].some((h) => new RegExp(`\\b${h}\\(`).test(chunk));
        if (reads || calls) {
          helpers.add(name);
          changed = true;
        }
      }
    }

    // The direct reads.
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]!);
    for (const m of src.matchAll(/process\.env\.get\("([A-Z0-9_]+)"\)/g)) names.add(m[1]!);
    for (const m of src.matchAll(/process\.env\["([A-Z0-9_]+)"\]/g)) names.add(m[1]!);

    // The reads through an **injected** environment object.
    //
    // `securityFromEnv(env: Record<string, string | undefined>)` reads eight
    // variables that way — `ALLOWED_ORIGINS`, `ENFORCE_HTTPS`, the body ceiling
    // and the rest — and a scan that only looked at `process.env` would be
    // blind to every one of them. The parameter name is found in the source
    // rather than assumed, so a new injected environment is picked up without
    // this file being edited.
    for (const m of src.matchAll(/(\w+):\s*Record<string,\s*string\s*\|\s*undefined>/g)) {
      const param = m[1]!;
      for (const r of src.matchAll(new RegExp(`\\b${param}\\.([A-Z0-9_]+)`, "g"))) {
        names.add(r[1]!);
      }
    }
  }

  // The call sites, once the helpers are known.
  if (helpers.size > 0) {
    const pattern = new RegExp(`\\b(${[...helpers].join("|")})\\(\\s*"([A-Z0-9_]+)"`, "g");
    for (const file of sources) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(pattern)) names.add(m[2]!);
    }
  }

  return { helpers: [...helpers], names };
}

/** The names the deployment passes to the `api` service. */
function composeApiEnv(compose: string): Set<string> {
  const keys = new Set<string>();
  let inApi = false;
  let inEnv = false;
  for (const line of compose.split(/\r?\n/)) {
    if (/^ {2}[a-z0-9-]+:/.test(line)) {
      inApi = /^ {2}api:/.test(line);
      inEnv = false;
      continue;
    }
    if (!inApi) continue;
    if (/^ {4}environment:/.test(line)) {
      inEnv = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      inEnv = false;
      continue;
    }
    if (inEnv) {
      const m = line.match(/^ {6}([A-Z0-9_]+):/);
      if (m) keys.add(m[1]!);
    }
  }
  return keys;
}

describe("the deployment hands the API everything it reads", () => {
  const sources = apiSources(SRC);
  const { helpers, names } = readerNames(sources);
  const passed = composeApiEnv(COMPOSE);

  it("finds the API's environment readers rather than assuming them", () => {
    // If the scan stopped finding the computed readers, the gate would go
    // quiet about exactly the variables it exists to catch: `TRIALS_ADDRESS`,
    // `PORT` and the rest are read through a helper, not directly.
    expect(helpers.length).toBeGreaterThan(0);
    expect(names.has("TRIALS_ADDRESS")).toBe(true);
    expect(names.has("PORT")).toBe(true);
  });

  it("passes every variable the API reads", () => {
    const missing = [...names].filter((n) => !passed.has(n)).sort();
    expect(
      missing,
      `compose.yaml does not pass these to the api service, so the API reads them as empty on a deployed box: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("passes the speech host's own switches", () => {
    // Named separately so the failure says which feature went dark, rather
    // than leaving a reader to work out that "some variable" was the mic.
    expect(passed.has("STS_DISABLED")).toBe(true);
    expect(passed.has("ELEVENLABS_STT_MODEL_ID")).toBe(true);
  });

  it("passes the sponsorship queue's owner list and its notification channel", () => {
    // The queue is unreadable without the owner list, and the notice goes
    // nowhere without the webhook: the feature was on in the source and off
    // in the deployment.
    expect(passed.has("CRUCIBLE_OWNER_ADDRESSES")).toBe(true);
    expect(passed.has("WARDEN_WEBHOOK_URL")).toBe(true);
  });
});
