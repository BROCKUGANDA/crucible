/**
 * @file base58.ts — base58 decoding, for Solana public keys.
 *
 * Solana addresses are base58, and the account data they point at is raw bytes.
 * Comparing an address to the bytes inside a token account therefore needs a
 * decoder. It is implemented here, small and dependency-free, rather than pulled
 * in, because the only thing this package needs from base58 is "address -> 32
 * bytes" and a library would add a supply-chain edge to a module that is
 * supposed to be readable end to end.
 *
 * The arithmetic is byte-wise rather than BigInt: a 44-character base58 string
 * is at most 352 bits, and repeated multiply-and-add into a 256-bit buffer is
 * both exact and allocation-cheap.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]!] = i;
  return map;
})();

/**
 * Decode a base58 string.
 *
 * Returns `null` for a string that contains a character outside the alphabet
 * rather than throwing, so a malformed address is a refusal at the call site
 * and not an exception escaping a verification function.
 */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return new Uint8Array(0);

  // Leading '1's are leading zero bytes.
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros += 1;

  // Little-endian accumulation over the remaining characters.
  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    const value = INDEX[input[i]!];
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // Big-endian accumulation into a base58 digit list (little-endian order).
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

/** Is this a syntactically valid 32-byte Solana address? */
export function isSolanaAddress(value: string): boolean {
  const bytes = base58Decode(value);
  return bytes !== null && bytes.length === 32;
}