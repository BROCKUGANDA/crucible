import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The deployment wiring, asserted on the statements that RUN.
 *
 * The bypass of 2026-10-27 was not a bad gate — the gate code was correct and its tests
 * passed. It was an installer that never copied the gate, a bind-mounted Caddyfile that
 * nobody recreated, and a CI job that ran none of these tests. Each of those is invisible
 * to a prose review and visible to a check that reads the executed lines: this file's
 * `code()` strips comments first, because a script that *explains* a flag in its header
 * contains the flag, and that exact mistake is written down in AGENTS.md.
 */

const here = dirname(fileURLToPath(import.meta.url));
// LF-normalised on read: the working tree of a Windows checkout is CRLF while the blobs are
// LF, and a block regex that demands "\n\n" is a test that changes colour with the
// operator's platform instead of with the code.
const read = (rel) => readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");

/** Non-comment lines, joined — the statements a shell would execute. */
function code(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

test("the installer copies the gate into the directory compose mounts", () => {
  const sh = code(read("./provision.sh"));
  assert.match(sh, /cp\s+"\$SRC"\/rpc-gate\/\*\.mjs\s+"\$INSTALL_DIR\/rpc-gate\/"/);
  assert.match(sh, /mkdir\s+-p[^\n]*rpc-gate/);
});

test("the installer recreates caddy when the config changed", () => {
  const sh = code(read("./provision.sh"));
  // A bind-mounted Caddyfile is not reloaded (this edge runs with `admin off`), so an
  // install that only copies files leaves the running proxy serving the old route.
  assert.match(sh, /docker compose[^\n]*--force-recreate[^\n]*caddy/);
  // And the decision must be made before the copy, or the comparison is trivially equal.
  const copyAt = sh.indexOf('cp "$SRC/Caddyfile"');
  const detectAt = sh.indexOf("cmp -s");
  assert.ok(detectAt !== -1 && copyAt !== -1 && detectAt < copyAt, "the change must be measured before the files are copied");
});

test("the installer refuses to finish while the endpoint answers control methods", () => {
  const sh = code(read("./provision.sh"));
  // Both legs of the certificate check must ask, so an absent certificate cannot quietly
  // skip the probe: the TLS leg goes through the edge, the other leg goes through the
  // gate service inside the network.
  assert.match(sh, /node "\$INSTALL_DIR\/rpc-gate\/probe\.mjs"/);
  assert.match(sh, /docker exec crucible-edge-rpc-gate-1 node \/gate\/probe\.mjs/);
  // The TLS leg must connect to the loopback edge while naming the public host, or the
  // check would leave the box and measure the front door instead.
  assert.match(sh, /--connect-to "127\.0\.0\.1:\$TLS_PORT"/);
  assert.match(sh, /--servername "\$NAME"/);
});

test("the edge routes /anvil to the gate and only to the gate", () => {
  const caddy = read("./Caddyfile")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const block = caddy.match(/handle @anvil \{([\s\S]*?)\n\t\}/);
  assert.ok(block, "the @anvil handle block is gone — the RPC path has no route at all");
  assert.match(block[1], /reverse_proxy\s+rpc-gate:8791/);
  assert.doesNotMatch(block[1], /anvil:8545/, "/anvil must not be proxied to the node directly");
});

test("the gate service is defined, mounted, and holds no key", () => {
  const compose = read("./compose.yaml")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const gate = compose.match(/^ {2}rpc-gate:\n((?:.*\n)*?)(?=^\S)/m);
  assert.ok(gate, "the rpc-gate service is missing from the edge compose file");
  assert.match(gate[1], /-\s+\.\/rpc-gate:\/gate:ro/);
  assert.match(gate[1], /RPC_GATE_UPSTREAM:\s+http:\/\/anvil:8545/);
  // The gate's security property is that compromising it gains nothing: it publishes no
  // host port and carries no credential into the container.
  assert.doesNotMatch(gate[1], /ports:/, "the gate must not publish a host port");
  assert.doesNotMatch(gate[1], /PRIVATE_KEY|_KEY:/i, "the gate must hold no key");
});

test("the deploy reconciles the edge from the synced tree", () => {
  const workflow = read("../../.github/workflows/deploy.yml");
  const steps = workflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  // The INVOCATION, not the path. A step that only checks the file exists contains the
  // same string, and a gate written against that string stays green when the run line is
  // deleted — which is the mistake AGENTS.md already records for `--strict`.
  const invoked = steps.match(/^\s*bash\s+deploy\/edge\/provision\.sh\s*$/m);
  assert.ok(invoked, "nothing in deploy.yml actually runs provision.sh");
  // An edge that fails its probe must not leave a half-swapped application behind, so the
  // reconcile belongs before the container swap.
  assert.ok(invoked.index < steps.indexOf("swap web, api and keeper"), "reconcile the edge before swapping the app");
});
