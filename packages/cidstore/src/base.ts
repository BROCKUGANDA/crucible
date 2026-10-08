/**
 * base58btc and base32, implemented over the bytes rather than over a number.
 *
 * An IPFS content id is just one of these two encodings of the same multihash, so
 * anything that claims to speak IPFS has to get both right — and a bug here is not a
 * crash, it is a plausible-looking id that no node on earth can resolve. That is why
 * the encodings are hand-written and vector-tested against RFC 4648 and published
 * base58 vectors instead of pulled in: the verification path (Argus re-deriving an id
 * from bytes it was handed) must not depend on a library nobody audited.
 *
 * Both encodings are big-integers-by-repeated-division over the byte array. Doing it
 * with `BigInt` would be shorter, but base58 of a 34-byte multihash and base32 of a
 * 36-byte CID are the *whole* input, so the intermediate values stay inside 32 bits
 * and the loops are the ones from the original Bitcoin implementations.
 */

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingError";
  }
}

/** Bitcoin's alphabet: no 0, O, I or l, so a misread character cannot silently decode. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

const B58_INDEX = indexAlphabet(B58);
const B32_INDEX = indexAlphabet(B32);

function indexAlphabet(alphabet: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i += 1) map.set(alphabet[i]!, i);
  return map;
}

/** log(256)/log(58): the most base58 characters a byte can expand to. */
const B58_BYTES_PER_CHAR = 0.733_009_399_4;
/** log(58)/log(256): the most bytes a base58 character can carry. */
const B58_CHARS_PER_BYTE = 1.365_658_936_1;

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits = new Uint8Array(Math.ceil((bytes.length - zeros) * B58_CHARS_PER_BYTE) + 1);
  let size = 0;
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    for (let j = 0; j < size; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits[size] = carry % 58;
      size += 1;
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let j = size - 1; j >= 0; j -= 1) out += B58[digits[j]!];
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;

  const digits = new Uint8Array(Math.ceil((text.length - zeros) * B58_BYTES_PER_CHAR) + 1);
  let size = 0;
  for (let i = zeros; i < text.length; i += 1) {
    const value = B58_INDEX.get(text[i]!);
    if (value === undefined) throw new EncodingError(`not a base58 character: ${text[i]}`);
    let carry = value;
    for (let j = 0; j < size; j += 1) {
      carry += digits[j]! * 58;
      digits[j] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      digits[size] = carry & 0xff;
      size += 1;
      carry = Math.floor(carry / 256);
    }
  }

  const out = new Uint8Array(zeros + size);
  for (let j = 0; j < size; j += 1) out[zeros + size - 1 - j] = digits[j]!;
  return out;
}

/**
 * base32 without padding, lowercase — multibase's `b`. RFC 4648's `=` padding is
 * dropped because a CID has to survive being pasted into a URL or a chain record, and
 * the discarded low bits are re-checked on decode so a truncated id cannot pass.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]!;
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of text.toLowerCase()) {
    const digit = B32_INDEX.get(ch);
    if (digit === undefined) throw new EncodingError(`not a base32 character: ${ch}`);
    value = ((value << 5) | digit) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  if (bits >= 5) throw new EncodingError(`truncated base32 input: ${text.length} characters`);
  if (value !== 0) throw new EncodingError("base32 tail is not zero padding");
  return Uint8Array.from(out);
}
