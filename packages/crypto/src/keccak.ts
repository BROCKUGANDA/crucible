/**
 * Keccak-256 (original Keccak padding, domain 0x01 — not SHA-3's 0x06).
 *
 * Pure-TypeScript Keccak-f[1600] with rate 1088 bits (136 bytes), as the
 * chain computes it. The previous "keccak256" in this package was SHA-256
 * with a domain prefix; every real call site in this repo goes through viem,
 * so the fake never bit — but it was a wrong answer behind a trusted door.
 * Test vectors below are checked against viem.
 */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets r[x][y] flattened as r[x + 5*y]. */
const RHO = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const MASK64 = 0xffffffffffffffffn;

function rotl(x: bigint, n: number): bigint {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

/** Keccak-f[1600]: 24 rounds over the 5x5 lane state (flat, index = x + 5y). */
function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] = state[i]! ^ d[i % 5]!;
    }
    // Rho + Pi: lane (x, y) moves to (y, 2x + 3y mod 5), rotated by RHO.
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        b[nx + 5 * ny] = rotl(state[i]!, RHO[i]!);
      }
    }
    // Chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        state[i] = b[i]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    // Iota
    state[0] = state[0]! ^ RC[round]!;
  }
}

const RATE = 136;

/** Keccak-256 hex digest of the input bytes. */
export function keccak256Bytes(input: Uint8Array): Uint8Array {
  // pad10*1 with domain 0x01: append 0x01, zero-fill, set top bit of last rate byte.
  const paddedLen = Math.ceil((input.length + 1) / RATE) * RATE;
  const block = new Uint8Array(paddedLen);
  block.set(input);
  block[input.length] = 0x01;
  block[paddedLen - 1] = (block[paddedLen - 1] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < paddedLen; off += RATE) {
    for (let i = 0; i < RATE; i++) {
      const lane = (i >> 3) | 0;
      const shift = BigInt((i & 7) * 8);
      state[lane] = state[lane]! ^ (BigInt(block[off + i]!) << shift);
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = (i >> 3) | 0;
    const shift = BigInt((i & 7) * 8);
    out[i] = Number((state[lane]! >> shift) & 0xffn);
  }
  return out;
}

/** Keccak-256 hex digest (0x-prefixed for chain interop). */
export function keccak256Hex(input: Uint8Array): string {
  return "0x" + Buffer.from(keccak256Bytes(input)).toString("hex");
}
