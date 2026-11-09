import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fresh-box installer, asserted on the statements that run.
 *
 * Same instrument as provision.test.mjs, for the same reason: the 2026-10-27 bypass was
 * an installer whose prose said the right thing and whose executed lines did not. Every
 * file below goes through `code()` first — comments stripped — so an assertion cannot be
 * satisfied by the header explaining it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");

function code(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

test("the bootstrap refuses a host that cannot run the stack", () => {
  const sh = code(read("../../scripts/bootstrap.sh"));
  assert.match(sh, /command -v docker/);
  assert.match(sh, /docker info/);
  // `!reset` arrived in compose 2.24; older versions silently merge the ports back.
  assert.match(sh, /-lt 24/);
  assert.match(sh, /df -Pk/);
});

test("the bootstrap never overwrites a host .env and never prints a secret", () => {
  const sh = code(read("../../scripts/bootstrap.sh"));
  // Scaffold only when absent.
  assert.match(sh, /if \[ ! -f "\$ROOT\/\.env" \]; then/);
  assert.match(sh, /cp "\$ROOT\/\.env\.example" "\$ROOT\/\.env"/);
  // No value is ever read out or echoed: no `cat .env`, no `set -x`, no export of a value.
  assert.doesNotMatch(sh, /cat\s+"?\$ROOT\/\.env"?/);
  assert.doesNotMatch(sh, /set -x/);
});

test("the bootstrap installs the app, then the edge, then probes the public surface", () => {
  const sh = code(read("../../scripts/bootstrap.sh"));
  const upAt = sh.indexOf("up -d");
  const provisionAt = sh.indexOf('bash "$ROOT/deploy/edge/provision.sh"');
  const probeAt = sh.indexOf("rpc-gate/probe.mjs");
  assert.ok(upAt !== -1, "the app stack is never started");
  assert.ok(provisionAt !== -1, "the edge installer is never invoked");
  assert.ok(probeAt !== -1, "the gate probe is never run");
  // Order is the install: stack before edge (the edge joins its network), edge before probes.
  assert.ok(upAt < provisionAt, "the stack must exist before the edge attaches to it");
  assert.ok(provisionAt < probeAt, "the edge must be installed before it is probed");
});

test("the bootstrap never tears down shared volumes", () => {
  const sh = code(read("../../scripts/bootstrap.sh"));
  assert.doesNotMatch(sh, /down\s+-v/);
  assert.doesNotMatch(sh, /docker compose[^\n]*\bdown\b/);
});
