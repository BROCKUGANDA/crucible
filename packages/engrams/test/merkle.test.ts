import { describe, it, expect } from "vitest";
import { buildMerkleTree, verifyProof, getProof, leafFor } from "../src/index.js";

const CHAIN = 31337n;

describe("the canonical leaf", () => {
  it("re-derives the digest the tree builder uses", () => {
    const leaf = { recipient: "0x1111111111111111111111111111111111111111" as const, amount: 1n, campaignId: 0n, tokenId: 1001n };
    const tree = buildMerkleTree([leaf], CHAIN);
    expect(leafFor(leaf, CHAIN)).toBe(tree.leaves[0]);
    expect(getProof(tree, leafFor(leaf, CHAIN))).toEqual([]);
    expect(verifyProof(leafFor(leaf, CHAIN), [], tree.root)).toBe(true);
  });
});

describe("Merkle tree", () => {
  it("single leaf root equals leaf", () => {
    const tree = buildMerkleTree(
      [{ recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n, tokenId: 1001n }],
      CHAIN,
    );
    expect(tree.leaves).toHaveLength(1);
    expect(verifyProof(tree.leaves[0], getProof(tree, tree.leaves[0]), tree.root)).toBe(true);
  });

  it("verifies proofs for all leaves in a multi-leaf tree", () => {
    const leaves = [
      { recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n, tokenId: 1001n },
      { recipient: "0x2222222222222222222222222222222222222222", amount: 2n, campaignId: 0n, tokenId: 1001n },
      { recipient: "0x3333333333333333333333333333333333333333", amount: 3n, campaignId: 0n, tokenId: 1002n },
      { recipient: "0x4444444444444444444444444444444444444444", amount: 4n, campaignId: 0n, tokenId: 1002n },
    ];
    const tree = buildMerkleTree(leaves, CHAIN);
    for (const leaf of tree.leaves) {
      expect(verifyProof(leaf, getProof(tree, leaf), tree.root)).toBe(true);
    }
  });

  it("rejects a tampered leaf", () => {
    const leaves = [
      { recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n, tokenId: 1001n },
      { recipient: "0x2222222222222222222222222222222222222222", amount: 2n, campaignId: 0n, tokenId: 1001n },
    ];
    const tree = buildMerkleTree(leaves, CHAIN);
    const fakeLeaf = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    expect(verifyProof(fakeLeaf as any, getProof(tree, tree.leaves[0]), tree.root)).toBe(false);
  });

  it("empty tree has zero root", () => {
    const tree = buildMerkleTree([], CHAIN);
    expect(tree.root).toBe("0x" + "0".repeat(64));
    expect(tree.leaves).toHaveLength(0);
  });

  it("a leaf built for one chain does not verify against a tree built for another", () => {
    const leaves = [
      { recipient: "0x1111111111111111111111111111111111111111", amount: 1n, campaignId: 0n, tokenId: 1001n },
      { recipient: "0x2222222222222222222222222222222222222222", amount: 2n, campaignId: 0n, tokenId: 1001n },
    ];
    const tree = buildMerkleTree(leaves, CHAIN);
    const otherChainTree = buildMerkleTree(leaves, 1n);
    // The same recipient/amount/campaign/token on another chain is a different leaf.
    expect(tree.leaves[0]).not.toBe(otherChainTree.leaves[0]);
    expect(verifyProof(tree.leaves[0], getProof(tree, tree.leaves[0]), otherChainTree.root)).toBe(false);
  });
});
