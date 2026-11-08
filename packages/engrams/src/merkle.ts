/**
 * @file merkle.ts — Off-chain Merkle tree builder for Engram campaigns.
 *
 * Produces a root + per-recipient proofs matching EngramDistributor's _verify,
 * which hashes sorted pairs (smaller first). Leaf = keccak256(encodePacked(recipient, amount, campaignId)).
 */

import { keccak256, encodePacked, type Hex } from "viem";

export interface MerkleLeaf {
  recipient: `0x${string}`;
  amount: bigint;
  campaignId: bigint;
}

export interface MerkleTree {
  root: Hex;
  leaves: Hex[];
  proofs: Map<Hex, Hex[]>;
}

function leafHash(leaf: MerkleLeaf): Hex {
  return keccak256(encodePacked(["address", "uint256", "uint256"], [leaf.recipient, leaf.amount, leaf.campaignId]));
}

function hashPair(a: Hex, b: Hex): Hex {
  return (a <= b
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]))) as Hex;
}

export function buildMerkleTree(leaves: MerkleLeaf[]): MerkleTree {
  const leafHashes: Hex[] = leaves.map(leafHash);
  const proofs = new Map<Hex, Hex[]>();

  if (leafHashes.length === 0) {
    const zero = ("0x" + "0".repeat(64)) as Hex;
    return { root: zero, leaves: [], proofs };
  }
  if (leafHashes.length === 1) {
    proofs.set(leafHashes[0]!, []);
    return { root: leafHashes[0]!, leaves: leafHashes, proofs };
  }

  let level: Hex[] = [...leafHashes];
  const levels: Hex[][] = [level];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as Hex;
      const b = i + 1 < level.length ? (level[i + 1] as Hex) : undefined;
      if (b !== undefined) {
        next.push(hashPair(a, b));
      } else {
        next.push(a);
      }
    }
    levels.push(next);
    level = next;
  }
  const root = level[0] as Hex;

  for (let li = 0; li < leafHashes.length; li++) {
    const proof: Hex[] = [];
    let idx = li;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const levelArr = levels[lvl] as Hex[];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (siblingIdx < levelArr.length) {
        proof.push(levelArr[siblingIdx] as Hex);
      }
      idx = Math.floor(idx / 2);
    }
    proofs.set(leafHashes[li] as Hex, proof);
  }

  return { root, leaves: leafHashes, proofs };
}

export function getProof(tree: MerkleTree, leaf: Hex): Hex[] {
  return tree.proofs.get(leaf) ?? [];
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let computed = leaf;
  for (const p of proof) {
    computed = (computed <= p
      ? keccak256(encodePacked(["bytes32", "bytes32"], [computed, p]))
      : keccak256(encodePacked(["bytes32", "bytes32"], [p, computed])));
  }
  return computed === root;
}
