import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { keccak256, stringToHex, decodeFunctionData } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { foundry, sepolia } from "wagmi/chains";
import {
  buildClaimTrial,
  buildCreateTrial,
  buildFileBreak,
  buildFinalize,
  buildRegisterAgent,
  buildSubmitRun,
  buildWithdraw,
  decodeRevert,
} from "../src/lib/useTx";
import { buildConfig, explorerTxUrl, shortAddress } from "../src/lib/wagmi";
import { validateWizard, EMPTY_WIZARD } from "../src/lib/wizard";

const RUNNER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("wallet configuration", () => {
  it("offers Coinbase Wallet alongside the injected fallback", () => {
    const config = buildConfig();
    expect(config.connectors.some((c) => /coinbase/i.test(c.name))).toBe(true);
  });
});

describe("transaction builders", () => {
  // decoding round-trips rather than asserting raw hex length: a length check would
  // pass even if the arguments were encoded in the wrong order
  it("encodes createTrial and decodes back to the same arguments", () => {
    const { data } = buildCreateTrial({
      specDigest: HASH,
      testsDigest: HASH,
      rewardWei: 10n ** 17n,
      deadline: 1_800_000_000,
      breakWindow: 43_200,
    });
    expect(decodeFunctionData({ abi: TRIALS_ABI, data }).functionName).toBe("createTrial");
    const args = decodeFunctionData({ abi: TRIALS_ABI, data }).args! as unknown as [
      bigint,
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
    ];
    expect(args[0]).toBe(10n ** 17n);
    expect(args[1]).toBe(HASH);
    expect(args[2]).toBe(HASH);
    expect(args[3]).toBe(1_800_000_000n);
    expect(args[4]).toBe(43_200n);
  });

  /**
   * `createTrial` is payable and reverts `RewardTooSmall()` unless `msg.value` covers the
   * reward, so the reward travels as value rather than as an argument. A builder that
   * returns bare calldata compiles, decodes, and can never land — which is exactly what it
   * did while this suite only checked the calldata.
   */
  it("escrows the reward as msg.value on createTrial", () => {
    const { value } = buildCreateTrial({
      specDigest: HASH,
      testsDigest: HASH,
      rewardWei: 1_000_000_000_000_000_000n,
      deadline: 1_800_000_000,
      breakWindow: 43_200,
    });
    expect(value).toBe(1_000_000_000_000_000_000n);
  });

  // The three other ways value leaves the wallet, pinned so a refactor cannot quietly
  // drop one and still pass every decode test.
  it("carries value on registerAgent and fileBreak", () => {
    expect(buildRegisterAgent({ metadataURI: "ipfs://x", runner: RUNNER, stakeWei: 42n }).value).toBe(42n);
    expect(buildFileBreak(3, HASH, 7n).value).toBe(7n);
  });

  it("carries no value on the actions that are not payable", () => {
    // claimTrial moves an already-escrowed bond; finalize and withdraw pay *out*.
    const claim = buildClaimTrial(3);
    expect(typeof claim).toBe("string");
    expect(typeof buildFinalize(3)).toBe("string");
    expect(typeof buildWithdraw()).toBe("string");
  });

  it("encodes registerAgent with the metadata string and runner", () => {
    const tx = buildRegisterAgent({
      metadataURI: "ipfs://manifest",
      runner: RUNNER,
      stakeWei: 10n ** 18n,
    });
    expect(tx.value).toBe(10n ** 18n);
    const decoded = decodeFunctionData({ abi: TRIALS_ABI, data: tx.data });
    expect(decoded.functionName).toBe("registerAgent");
    expect((decoded.args as unknown as [string, string])[0]).toBe("ipfs://manifest");
    expect((decoded.args as unknown as [string, string])[1]).toBe(RUNNER);
  });

  it("encodes a 1-argument function and round-trips its argument", () => {
    for (const [data, expected] of [
      [buildClaimTrial(7), 7n],
      [buildFinalize(9), 9n],
    ] as const) {
      const decoded = decodeFunctionData({ abi: TRIALS_ABI, data });
      expect(decoded.args).toEqual([expected]);
    }
  });

  it("encodes withdraw with no arguments", () => {
    const decoded = decodeFunctionData({ abi: TRIALS_ABI, data: buildWithdraw() });
    expect(decoded.functionName).toBe("withdraw");
    expect(decoded.args ?? []).toEqual([]);
    // selector plus nothing: a stray argument would show up here
    expect(buildWithdraw().length).toBe(2 + 8);
  });

  it("encodes fileBreak with its stake and proof", () => {
    const tx = buildFileBreak(3, HASH, 10n ** 16n);
    expect(tx.value).toBe(10n ** 16n);
    const args = decodeFunctionData({ abi: TRIALS_ABI, data: tx.data }).args as unknown as [
      bigint,
      `0x${string}`,
    ];
    expect(args[0]).toBe(3n);
    expect(args[1]).toBe(HASH);
  });

  it("encodes submitRun with the signature blob intact", () => {
    const sig = `0x${"11".repeat(65)}` as `0x${string}`;
    const data = buildSubmitRun({
      trialId: 4,
      runHash: HASH,
      signature: sig,
      sigDeadline: 1_700_000_000n,
    });
    const args = decodeFunctionData({ abi: TRIALS_ABI, data }).args as unknown as [
      bigint,
      `0x${string}`,
      `0x${string}`,
      bigint,
    ];
    expect(args[0]).toBe(4n);
    expect(args[1]).toBe(HASH);
    expect(args[2]).toBe(sig); // the 65-byte signature survives encoding
    expect(args[3]).toBe(1_700_000_000n);
  });

  it("round-trips a CID text through a digest the same way the contract commits", () => {
    const digest = keccak256(stringToHex("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("decodeRevert", () => {
  it("maps every named custom error to operator copy", () => {
    expect(decodeRevert(new Error("execution reverted: NotOpen()"))).toMatch(/already at this anvil/);
    expect(decodeRevert(new Error("reverted SigExpired()"))).toMatch(/sign again/);
    expect(decodeRevert(new Error("reverted BadSigner()"))).toMatch(/runner key/);
    expect(decodeRevert(new Error("reverted WindowOpen()"))).toMatch(/Skeptic window still open/);
  });

  it("finds a selector in details as well as the message", () => {
    const err = Object.assign(new Error("failed"), { details: "NotJudging()" });
    expect(decodeRevert(err)).toMatch(/Nothing to challenge/);
  });

  it("explains a user rejection rather than showing a selector", () => {
    expect(decodeRevert(new Error("User rejected the request"))).toMatch(/rejected/);
  });

  it("explains insufficient funds", () => {
    expect(decodeRevert(new Error("insufficient funds for intrinsic transaction cost"))).toMatch(
      /Not enough ETH/,
    );
  });

  it("explains a pending replacement", () => {
    expect(decodeRevert(new Error("replacement transaction underpriced"))).toMatch(/already in flight/);
  });

  it("explains an undeployed contract", () => {
    expect(decodeRevert(new Error("could not decode result: no contract at 0x0"))).toMatch(
      /not deployed on this network/,
    );
  });

  it("falls back to a safe sentence for an unknown revert, leaking no selector", () => {
    const out = decodeRevert(new Error("execution reverted: 0xdeadbeef"));
    expect(out).toMatch(/Nothing was lost/);
    expect(out).not.toContain("0xdeadbeef");
  });

  it("never throws on a non-Error input", () => {
    expect(() => decodeRevert("something odd")).not.toThrow();
  });
});

describe("shortAddress", () => {
  it("uses the copy deck's format", () => {
    expect(shortAddress("0x9f3e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8")).toBe("0x9f3e…d7e8");
  });

  it("handles an absent address", () => {
    expect(shortAddress(undefined)).toBe("");
  });
});

describe("wizard to transaction", () => {
  it("produces a 20% bond from the reward the sponsor typed", () => {
    const v = validateWizard({
      ...EMPTY_WIZARD,
      spec: "Implement deposit() so the balance rises by msg.value.",
      testsCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      rewardEth: "0.5",
    });
    expect(v.ok).toBe(true);
    expect(v.bondEth).toBe("0.1");
  });
});

/**
 * A proof link that resolves to a page saying the transaction does not exist is worse than
 * no link, so the explorer is chosen by chain and refuses when there is nothing to choose.
 */
describe("explorerTxUrl", () => {
  const HASH = `0x${"ab".repeat(32)}`;

  it("links a full hash on a chain that declares an explorer", () => {
    const url = explorerTxUrl(HASH, sepolia);
    expect(url).toBe(`${sepolia.blockExplorers!.default.url}/tx/${HASH}`);
  });

  it("refuses rather than guessing on a chain with no explorer", () => {
    expect(explorerTxUrl(HASH, foundry)).toBeNull();
  });

  it("refuses a truncated or malformed hash", () => {
    // The UI shows `0x58b1…d94a0f`; a link built from the *label* would 404 confidently.
    expect(explorerTxUrl("0x58b1…d94a0f", sepolia)).toBeNull();
    expect(explorerTxUrl("", sepolia)).toBeNull();
    expect(explorerTxUrl(`0x${"ab".repeat(31)}`, sepolia)).toBeNull();
  });

  it("does not double the slash when the base ends with one", () => {
    const base = sepolia.blockExplorers!.default.url;
    const withSlash = { ...sepolia, blockExplorers: { default: { url: `${base}/`, name: "x", apiUrl: "" } } };
    expect(explorerTxUrl(HASH, withSlash)).toBe(`${base}/tx/${HASH}`);
  });
});

/**
 * `address()` used to do `process.env[name]`. Webpack inlines only static member
 * expressions into the client bundle, so a dynamic index survives as a real object access
 * against a `process.env` that does not exist in a browser — every deployment address
 * resolved to zero on the client while resolving fine on the server. The visible symptom
 * was the "Signing is disabled" notice on a build that had been configured exactly as the
 * README says, and a hydration mismatch on every page that mounts the header.
 */
describe("deployment resolution", () => {
  const keys = ["NEXT_PUBLIC_TRIALS_ADDRESS", "NEXT_PUBLIC_ALLOY_ADDRESS"] as const;

  async function reload() {
    vi.resetModules();
    return (await import("../src/lib/wagmi.js")).deployment();
  }

  it("is configured when both addresses are present", async () => {
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
    const dep = await reload();
    expect(dep.configured).toBe(true);
    expect(dep.trials).toBe("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0");
  });

  it("refuses to sign against the zero address when one is missing", async () => {
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
    delete process.env.NEXT_PUBLIC_ALLOY_ADDRESS;
    const dep = await reload();
    expect(dep.configured).toBe(false);
    expect(dep.alloy).toBe("0x0000000000000000000000000000000000000000");
  });

  it("ignores a malformed address rather than sending value into it", async () => {
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = "0x123";
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dep = await reload();
    expect(dep.configured).toBe(false);
    expect(dep.trials).toBe("0x0000000000000000000000000000000000000000");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  afterAll(() => {
    for (const k of keys) delete process.env[k];
  });
});

/**
 * The one check that does catch the bug these tests describe.
 *
 * Vitest runs in Node, where `process.env[name]` works, so no behavioural test written here
 * can fail against a dynamic lookup — only the browser bundle can. Grepping the source for
 * the pattern is the difference between a guard and a description, and it is the pattern
 * Next.js documents as unsupported in client code.
 */
describe("client env access", () => {
  it("contains no dynamic process.env reads", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) {
          const src = readFileSync(full, "utf8");
          for (const [i, raw] of src.split("\n").entries()) {
            const line = raw.trim();
            // Comments are allowed to describe the pattern — that is how the next reader
            // learns why it is banned. Skip them whole rather than stripping the marker
            // and matching the sentence underneath it.
            if (line.startsWith("*") || line.startsWith("/*") || line.startsWith("//")) continue;
            const code = line.replace(/\/\/.*$/, "");
            if (/process\.env\s*\[/.test(code)) offenders.push(`${entry}:${i + 1}: ${code.trim()}`);
          }
        }
      }
    };
    walk(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

    expect(offenders).toEqual([]);
  });
});

/**
 * Multi-user guards in `useTx` (the shared-browser account-switch hole).
 *
 * A transaction belongs to the account that sent it. The receipt cannot cross-wire —
 * a hash has exactly one sender — but the *presentation* could: without a reset on
 * account change, user B connecting after user A's "Poured." inherits A's terminal
 * result and gas line as if it were theirs. And an unconnected spectator clicking a
 * permissionless button deserves "connect a wallet", not "the network refused".
 *
 * There is no React renderer in this suite, so these are wiring checks over the
 * executed statements (comments filtered — the lesson from the `includes("--strict")`
 * gate that stayed green matching a script's prose).
 */
describe("useTx multi-user guards", () => {
  const source = readFileSync(new URL("../src/lib/useTx.ts", import.meta.url), "utf8");
  // Executable lines only: strip whole-line comments and trailing // comments.
  const code = source
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("*") && !l.startsWith("/*"))
    .join("\n");

  it("resets every terminal surface when the connected account changes", () => {
    // The effect must watch `address` and wipe all five surfaces — state, error,
    // hash, and both gas numbers — plus release the double-submit lock.
    const effectMatch = code.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[address\]\);/);
    expect(effectMatch, "an effect keyed on [address] exists").not.toBeNull();
    const effect = effectMatch![0];
    for (const reset of [
      "inFlight.current = false",
      'setState("idle")',
      "setError(null)",
      "setHash(null)",
      "setGasUsed(null)",
      "setGasWei(null)",
    ]) {
      expect(effect, `the reset must include ${reset}`).toContain(reset);
    }
    // And it must only fire on an actual change, not every render of the same
    // account. The condition is pinned as executed code, not prose: prepending
    // `false &&` to it (a mutation that survived an earlier, looser shape of
    // this check) turns this red.
    expect(effect).toContain("if (previous !== null && address !== previous) {");
  });

  it("refuses a send with no wallet connected, before deployment checks", () => {
    const guardAt = code.indexOf("if (!address)");
    const configAt = code.indexOf("assertConfigured()");
    expect(guardAt, "the !address guard exists").toBeGreaterThan(-1);
    expect(configAt, "assertConfigured is still called").toBeGreaterThan(-1);
    expect(guardAt, "wallet check precedes the deployment check").toBeLessThan(configAt);
    const guardBlock = code.slice(guardAt, guardAt + 260);
    expect(guardBlock).toContain("Connect a wallet to send this.");
    expect(guardBlock).toContain('setState("doused")');
  });

  it("keeps `address` in the send callback deps so the guard never goes stale", () => {
    // The property, not the literal array: the deps list grows as the hook
    // gains dependencies (the interaction lock, for one), and what must not
    // go is `address` - the guard reads it, and a stale copy of it would let
    // a disconnected wallet through.
    const deps = code.slice(code.lastIndexOf("[sendTransactionAsync"), code.indexOf(")", code.lastIndexOf("[sendTransactionAsync")));
    expect(deps).toContain("address");
  });
});
