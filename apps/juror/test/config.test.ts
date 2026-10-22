import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readConfig } from "../src/config.js";

/**
 * The refusals.
 *
 * Written as one test per variable because each is a different operator mistake, and the whole
 * value of the check is that the message names the variable to set. Anvil account #1's key is
 * used as the valid one: it is the demo's first Argus seat, it is already published in
 * Anvil's own docs and allowlisted in `.gitleaks.toml`, and `Demo.s.sol` derives the seat from
 * the dev mnemonic at index 1 — so a test that passes on it is a test of the key the demo uses.
 */

const SEAT_ONE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SEAT_ONE_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const base = {
  RPC_URL: "http://127.0.0.1:8545",
  TRIALS_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f63180aa3",
  SEAT_PRIVATE_KEY: SEAT_ONE_KEY,
  CONTENT_DIR: ".crucible-content",
};

/** The variables a developer's shell may already have set must not be able to satisfy a test. */
const KEYS = Object.keys(base);
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("readConfig", () => {
  it("accepts a complete environment and derives the seat address from the key", () => {
    const cfg = readConfig({ ...base });
    expect(cfg.account.address).toBe(SEAT_ONE_ADDRESS);
    expect(cfg.trialsAddress).toBe(base.TRIALS_ADDRESS);
    expect(cfg.rpcUrl).toBe(base.RPC_URL);
  });

  it.each([
    "RPC_URL",
    "TRIALS_ADDRESS",
    "SEAT_PRIVATE_KEY",
    "CONTENT_DIR",
  ] as const)("refuses when %s is missing, and names it", (name) => {
    const env: Record<string, string> = { ...base };
    delete env[name];
    expect(() => readConfig(env)).toThrowError(new RegExp(`juror refusing to start: ${name} is required`));
  });

  it.each([
    "RPC_URL",
    "TRIALS_ADDRESS",
    "SEAT_PRIVATE_KEY",
    "CONTENT_DIR",
  ] as const)("treats an empty %s as missing, because that is what compose hands over", (name) => {
    // `SEAT_PRIVATE_KEY: ${SEAT_PRIVATE_KEY:-}` arrives as "" — a check for `undefined` alone
    // would let the most likely misconfiguration through the front door.
    expect(() => readConfig({ ...base, [name]: "" })).toThrowError(/is required and is unset or empty/);
    expect(() => readConfig({ ...base, [name]: "   " })).toThrowError(/is required and is unset or empty/);
  });

  it("never falls back to a key of its own", () => {
    // The keeper may use Anvil's published dev key when the RPC is provably the local demo.
    // A seat may not: it signs verdicts, and a path that "just uses a dev key" is a path an
    // operator selects by forgetting a variable. The address below is the fallback this
    // refuses to take, asserted rather than trusted.
    const env: Record<string, string> = { ...base };
    delete env.SEAT_PRIVATE_KEY;
    expect(() => readConfig(env)).toThrow();
    expect(() => readConfig(env)).toThrowError(/SEAT_PRIVATE_KEY/);

    // And no partial configuration ever produces account #0, the key the audit was about.
    const anvilZero = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const withBlank = readConfig(base);
    expect(withBlank.account.address.toLowerCase()).not.toBe(anvilZero.toLowerCase());
  });

  it("rejects a malformed key without echoing it back", () => {
    const leaked = "0xdeadbeef";
    let message = "";
    try {
      readConfig({ ...base, SEAT_PRIVATE_KEY: leaked });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SEAT_PRIVATE_KEY must be 32 bytes");
    // A truncated key is often the head of a real one, and a thrown message ends up in a log.
    expect(message).not.toContain(leaked);
  });

  it("rejects a trials address that is not 20 bytes, quoting what was given", () => {
    expect(() => readConfig({ ...base, TRIALS_ADDRESS: "0x1234" })).toThrowError(/not a 20-byte hex address/);
  });

  it("refuses a non-numeric interval rather than reading it as NaN", () => {
    // `Number("")` is 0 and `Number("abc")` is NaN; a loop scheduled on either is a loop that
    // either spins with no delay or never fires, and neither looks wrong until it is on call.
    expect(() => readConfig({ ...base, PATROL_MS: "soon" })).toThrowError(/PATROL_MS must be a positive number/);
    expect(() => readConfig({ ...base, PATROL_MS: "0" })).toThrowError(/PATROL_MS/);
  });

  it("refuses a FROM_BLOCK that is not an integer", () => {
    expect(() => readConfig({ ...base, FROM_BLOCK: "12.5" })).toThrowError(/FROM_BLOCK "12\.5" is not an integer/);
    expect(readConfig({ ...base, FROM_BLOCK: "42" }).fromBlock).toBe(42n);
  });

  it("keeps the seat's secrets out of the content directory", () => {
    // Compared through `path.resolve` rather than a literal: this suite runs on a Windows dev
    // box and a Linux container, and a hand-written "/srv/..." separator is a test that only
    // passes on half the machines that run it.
    const content = path.resolve("/srv/crucible/.crucible-content");
    const cfg = readConfig({ ...base, CONTENT_DIR: content });
    expect(cfg.stateDir).toBe(path.resolve("/srv/crucible", "juror-state"));
    // The default is a sibling, never the store itself: the content directory is a host path the
    // pinning one-shot also writes, and unopened salts do not belong in a tree that a command
    // whose whole job is that tree can repopulate or delete.
    expect(cfg.stateDir).not.toBe(content);
    expect(cfg.contentDir).toBe(content);
  });

  it("takes the state directory from STATE_DIR when an operator has one", () => {
    expect(readConfig({ ...base, STATE_DIR: "/var/lib/crucible-seat" }).stateDir).toBe(
      path.resolve("/var/lib/crucible-seat"),
    );
  });

  it("defaults the cadence rather than requiring it", () => {
    const cfg = readConfig(base);
    expect(cfg.port).toBe(8790);
    expect(cfg.patrolMs).toBe(30_000);
    expect(cfg.reverifyMs).toBe(900_000);
    expect(cfg.fromBlock).toBeNull();
    expect(cfg.cursorFile).toBeUndefined();
  });
});
