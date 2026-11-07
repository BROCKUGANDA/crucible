import { describe, it, expect } from "vitest";
import { buildMerkleTree, verifyProof, getProof } from "../src/index.js";

describe("Merkle tree", () => {
  it("single leaf root equals leaf", () => {
    const tree = buildMerkleTree([{ recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n }]);
    expect(tree.leaves).toHaveLength(1);
    expect(verifyProof(tree.leaves[0], getProof(tree, tree.leaves[0]), tree.root)).toBe(true);
  });

  it("verifies proofs for all leaves in a multi-leaf tree", () => {
    const leaves = [
      { recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n },
      { recipient: "0x2222222222222222222222222222222222222222", amount: 2n, campaignId: 0n },
      { recipient: "0x3333333333333333333333333333333333333333", amount: 3n, campaignId: 0n },
      { recipient: "0x4444444444444444444444444444444444444444", amount: 4n, campaignId: 0n },
    ];
    const tree = buildMerkleTree(leaves);
    for (const leaf of tree.leaves) {
      expect(verifyProof(leaf, getProof(tree, leaf), tree.root)).toBe(true);
    }
  });

  it("rejects a tampered leaf", () => {
    const leaves = [
      { recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n },
      { recipient: "0x2222222222222222222222222222222222222222", amount: 2n, campaignId: 0n },
    ];
    const tree = buildMerkleTree(leaves);
    const fakeLeaf = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    expect(verifyProof(fakeLeaf as any, getProof(tree, tree.leaves[0]), tree.root)).toBe(false);
  });

  it("empty tree has zero root", () => {
    const tree = buildMerkleTree([]);
    expect(tree.root).toBe("0x" + "0".repeat(64));
    expect(tree.leaves).toHaveLength(0);
  });
});
