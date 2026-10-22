import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  concatHex,
  encodeAbiParameters,

  hashTypedData,
  keccak256,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import {
  DOMAIN_TYPEHASH,
  RUN_PRIMARY_TYPE,
  RUN_TYPEHASH,
  RUN_TYPES,
  domainFor,
} from "../src/eip712.js";

/**
 * EIP-712 digest parity between the SDK and the contract.
 *
 * Both sides hand-roll the same construction. `CrucibleTrials.submitRun` computes
 *   keccak256(abi.encodePacked("\x19\x01", DOMAIN,
 *     keccak256(abi.encode(RUN_TYPEHASH, id, aid, runHash, sigDeadline))))
 * and recovers the signer from it. The SDK asks a wallet to sign what viem's
 * `hashTypedData` produces from `RUN_TYPES`. Two independent implementations of one
 * specification, agreeing only by coincidence — so nothing but this file stops them
 * drifting.
 *
 * Drift here is not a loud failure. A mismatched digest means `_recover` returns an
 * address that is not the registered runner, and `submitRun` reverts `BadSigner` for
 * every honest agent while a signature over the *wrong* struct still validates. The
 * contract would keep accepting submissions; the product's anti-fraud step would be the
 * thing that changed.
 *
 * The expectations are parsed out of the committed `.sol` source rather than restated
 * here, in the same style as `abi-drift.test.ts`: Solidity's field order is the thing
 * under test, so re-quoting it in this file would let both sides move together. It also
 * means the test needs no compiler and no chain, and runs in the plain JS job.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../crucible-contracts/contracts/CrucibleTrials.sol", import.meta.url)),
  "utf8",
);

/** Reads `keccak256("<literal>")` out of the source by the constant's name. */
function solidityTypehashOf(constantName: string): string {
  const pattern = new RegExp(
    `${constantName}\\s*=\\s*\\n?\\s*keccak256\\(\\s*"([^"]+)"\\s*\\)`,
    "m",
  );
  const found = pattern.exec(SOURCE);
  if (!found?.[1]) {
    throw new Error(
      `${constantName} is not declared as a literal keccak256("...") in the source — ` +
        `this test must not quietly pass because a regex stopped matching.`,
    );
  }
  return found[1];
}

/** `Run(uint256 trialId,...)` → [{ type, name }], in the source's own order. */
function parseParamList(typeString: string): { name: string; type: string }[] {
  const inside = /\(([^)]*)\)/.exec(typeString)?.[1];
  if (inside === undefined) throw new Error(`no parameter list in "${typeString}"`);
  if (!inside.trim()) return [];
  return inside.split(",").map((part) => {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length !== 2) throw new Error(`cannot read a parameter from "${part}"`);
    return { type: tokens[0]!, name: tokens[1]! };
  });
}

describe("RUN_TYPEHASH parity with the contract", () => {
  const solString = solidityTypehashOf("RUN_TYPEHASH");

  it("the contract's Run encode-type is the string the SDK hashes", () => {
    expect(solString).toBe("Run(uint256 trialId,uint256 agentId,bytes32 runHash,uint64 sigDeadline)");
  });

  it("both sides reach the same typehash", () => {
    expect(keccak256(stringToHex(solString))).toBe(RUN_TYPEHASH);
  });

  it("RUN_TYPES carries the source's field names and order, not a copy of it", () => {
    // This is the assertion that catches a reorder. Solidity encodes the struct in the
    // order written in the type string; if a field is inserted or moved, the digest
    // changes while every individual field still looks correct.
    const fromSource = parseParamList(solString);
    expect(RUN_TYPES.Run.map((f) => `${f.type} ${f.name}`)).toEqual(
      fromSource.map((f) => `${f.type} ${f.name}`),
    );
  });

  it("the primary type matches the struct name in the source", () => {
    expect(RUN_PRIMARY_TYPE).toBe(solString.split("(")[0]);
  });
});

describe("domain parity with the contract", () => {
  const solString = solidityTypehashOf("_DOMAIN_TYPEHASH");

  it("the domain encode-type string matches", () => {
    expect(solString).toBe(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    expect(keccak256(stringToHex(solString))).toBe(DOMAIN_TYPEHASH);
  });

  it("_computeDomain hashes the same name and version the SDK sends", () => {
    // CrucibleTrials._computeDomain(): keccak256(abi.encode(_DOMAIN_TYPEHASH,
    // keccak256("Crucible"), keccak256("1"), block.chainid, address(this)))
    const compute = /function _computeDomain\(\)[\s\S]*?return([\s\S]*?);\s*}/.exec(SOURCE);
    if (!compute?.[1]) throw new Error("_computeDomain was not found in the source");
    const body = compute[1];
    const domain = domainFor("0x0000000000000000000000000000000000000001", 31337);
    expect(domain.name).toBe("Crucible");
    expect(domain.version).toBe("1");
    expect(body).toContain(`keccak256("${domain.name}")`);
    expect(body).toContain(`keccak256("${domain.version}")`);
    expect(body).toContain("block.chainid");
    expect(body).toContain("address(this)");
  });

  it("the domain is chain-bound, so a signature cannot be replayed cross-chain", () => {
    const a = domainFor("0x0000000000000000000000000000000000000001", 31337);
    const b = domainFor("0x0000000000000000000000000000000000000001", 1);
    expect(hashTypedData({ domain: a, primaryType: RUN_PRIMARY_TYPE, types: RUN_TYPES, message: runMessage() }))
      .not.toBe(
        hashTypedData({ domain: b, primaryType: RUN_PRIMARY_TYPE, types: RUN_TYPES, message: runMessage() }),
      );
  });
});

function runMessage() {
  return {
    trialId: 7n,
    agentId: 3n,
    runHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
    sigDeadline: 1_800_000_000n,
  };
}

/**
 * The contract's own formula, rebuilt literally from the source's parameter order.
 *
 * Deliberately not `hashTypedData`: that would compare viem with viem. This encodes
 * `abi.encode(RUN_TYPEHASH, <source order>)` and `abi.encodePacked("\x19\x01", DOMAIN, …)`
 * by hand, so agreement means two different implementations of EIP-712 landed on the
 * same 32 bytes.
 */
function solidityDigest(args: {
  verifyingContract: `0x${string}`;
  chainId: number;
  trialId: bigint;
  agentId: bigint;
  runHash: Hex;
  sigDeadline: bigint;
}): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(stringToHex("Crucible")),
        keccak256(stringToHex("1")),
        BigInt(args.chainId),
        args.verifyingContract,
      ],
    ),
  );

  // Field order comes from the .sol encode-type, exactly as submitRun writes it.
  const order = parseParamList(solidityTypehashOf("RUN_TYPEHASH"));
  const values: Record<string, bigint | Hex> = {
    trialId: args.trialId,
    agentId: args.agentId,
    runHash: args.runHash,
    sigDeadline: args.sigDeadline,
  };
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, ...order.map((f) => ({ type: f.type }))],
      [RUN_TYPEHASH, ...order.map((f) => values[f.name])],
    ),
  );

  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

describe("full digest: viem's hashTypedData against the contract's formula", () => {
  const verifyingContract = "0x5fbdb2315678afecb367f032d93f642f63180aa3" as const;
  const chainId = 31337;
  const message = runMessage();

  it("agree on one digest", () => {
    const fromViem = hashTypedData({
      domain: domainFor(verifyingContract, chainId),
      primaryType: RUN_PRIMARY_TYPE,
      types: RUN_TYPES,
      message,
    });
    const fromSolidityFormula = solidityDigest({ verifyingContract, chainId, ...message });
    expect(fromViem).toBe(fromSolidityFormula);
  });

  it("change the runHash and both move, identically", () => {
    const moved = { ...message, runHash: toHex("run-2", { size: 32 }) };
    expect(
      hashTypedData({
        domain: domainFor(verifyingContract, chainId),
        primaryType: RUN_PRIMARY_TYPE,
        types: RUN_TYPES,
        message: moved,
      }),
    ).toBe(solidityDigest({ verifyingContract, chainId, ...moved }));
  });

  it("the digest binds the trial id, so a signature cannot be replayed onto another trial", () => {
    const base = solidityDigest({ verifyingContract, chainId, ...message });
    const otherTrial = solidityDigest({ verifyingContract, chainId, ...message, trialId: 8n });
    expect(base).not.toBe(otherTrial);
  });

  it("the digest binds the deadline, so a captured signature expires rather than transfers", () => {
    const base = solidityDigest({ verifyingContract, chainId, ...message });
    const later = solidityDigest({ verifyingContract, chainId, ...message, sigDeadline: 1_800_000_001n });
    expect(base).not.toBe(later);
  });

  it("pins the typehash so a struct edit has to be a decision", () => {
    // A change-detector, not a cross-implementation proof: this is the same keccak the
    // test above already recomputes, so its only job is to make someone edit this line
    // when the struct changes. The genuine agreement between solc's keccak and viem's is
    // proven when the contract accepts a submission the SDK signed —
    // crucible-contracts/script/GoldenPath.s.sol, and its `BadSigner` revert is what
    // fails if the two ever disagree.
    expect(RUN_TYPEHASH).toBe("0xc9b67c5fd4768fbec9199c6a7de32fbce913dce92dc486686840dc8865a8fb57");
  });
});

describe("contract source still spells the digest the way this test assumes", () => {
  it("submitRun packs \x19\x01, DOMAIN and the struct hash in that order", () => {
    const submit = /function submitRun\([\s\S]*?\n    }/.exec(SOURCE);
    if (!submit?.[0]) throw new Error("submitRun was not found in the source");
    const body = submit[0];
    expect(body).toContain(`"\\x19\\x01", DOMAIN, keccak256(abi.encode(RUN_TYPEHASH,`);
    // And the recovered address is compared to the registered runner — the whole point
    // of the digest. If this assertion breaks, `_recover` is no longer gating a write.
    expect(body).toContain("_recover(digest, sig)");
    expect(body).toContain("agents[aid].runner");
  });

  it("the domain separator is a constant built at construction", () => {
    expect(SOURCE).toContain("DOMAIN = _computeDomain()");
  });
});
