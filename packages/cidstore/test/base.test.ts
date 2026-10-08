import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, base58Decode, base58Encode, EncodingError } from "../src/index.js";

/**
 * The expected values here are not computed by this package. They were checked against
 * independent implementations before being written down: RFC 4648 section 10 for base32,
 * `bs58` 6.0.0 and `@scure/base` 1.2.6 for base58, and Python 3.13's `base64.b32encode`
 * for the padding behaviour multibase drops. See the report accompanying this package.
 */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("base58Encode", () => {
  it("matches the independent implementations on the bytes of 'Hello World'", () => {
    expect(base58Encode(bytes("Hello World"))).toBe("JxF12TrwUP45BMd");
  });

  it("encodes no bytes as the empty string", () => {
    expect(base58Encode(new Uint8Array(0))).toBe("");
  });

  it("keeps leading zero bytes as '1', which is what makes an id lose information", () => {
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58Encode(new Uint8Array([0, 0, 0]))).toBe("111");
    expect(base58Encode(new Uint8Array([0, 255]))).toBe("15Q");
  });

  it("never emits a character that is not in the alphabet", () => {
    const alphabet = new Set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
    const sample = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) sample[i] = i;
    const encoded = base58Encode(sample);
    for (const ch of encoded) expect(alphabet.has(ch)).toBe(true);
    expect(encoded).not.toMatch(/[0OIl]/);
  });

  it("grows to the width a 34-byte multihash needs, which is the 46-character CIDv0", () => {
    const multihash = new Uint8Array(34).fill(7);
    expect(base58Encode(multihash)).toHaveLength(46);
  });
});

describe("base58Decode", () => {
  it("reverses the published vector", () => {
    expect(base58Decode("JxF12TrwUP45BMd")).toEqual(bytes("Hello World"));
  });

  it("round-trips every byte value, and every run of leading zeros", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    for (const sample of [all, new Uint8Array(0), new Uint8Array([0]), new Uint8Array([0, 0, 0, 1, 2, 3])]) {
      expect(base58Decode(base58Encode(sample))).toEqual(sample);
    }
  });

  it("rejects the four characters base58 leaves out of the alphabet", () => {
    for (const bad of ["0", "O", "I", "l"]) {
      expect(() => base58Decode(`Qm${bad}zsvyCQyizr73Gmms8ZRtvNxmgqumxc2KUp71dfEmoj`)).toThrow(EncodingError);
    }
  });

  it("round-trips a decodable-but-odd length without padding to a wrong value", () => {
    const text = base58Encode(new Uint8Array([1, 2, 3, 4, 5]));
    expect(base58Decode(text)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe("base32Encode", () => {
  it("matches the RFC 4648 section 10 vectors, padding stripped", () => {
    const cases: [string, string][] = [
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [input, expected] of cases) {
      expect(base32Encode(bytes(input)).toUpperCase()).toBe(expected);
    }
  });

  it("is lowercase and unpadded, because a CID has to survive a URL", () => {
    for (const input of ["f", "fo", "foo", "foob", "fooba", "foobar", ""]) {
      const encoded = base32Encode(bytes(input));
      expect(encoded).not.toContain("=");
      expect(encoded).toBe(encoded.toLowerCase());
    }
  });

  it("encodes a whole number of characters only when the input is a whole number of groups", () => {
    // 36 bytes (a CIDv1 sha2-256) is 58 characters: 290 bits of output for 288 bits of
    // input, so the last character carries two zero bits and the length is not a multiple of 8.
    expect(base32Encode(new Uint8Array(36))).toHaveLength(58);
    expect(base32Encode(new Uint8Array(34))).toHaveLength(55);
    expect(base32Encode(new Uint8Array(32))).toHaveLength(52);
  });

  it("round-trips every input length from 0 to 40, which is where the tail cases live", () => {
    const sample = new Uint8Array(41);
    for (let i = 0; i < 41; i += 1) sample[i] = (i * 7 + 3) & 0xff;
    for (let length = 0; length <= 40; length += 1) {
      const head = sample.subarray(0, length);
      expect(base32Decode(base32Encode(head))).toEqual(head);
    }
  });
});

describe("base32Decode", () => {
  it("accepts upper case, since the alphabet is case-insensitive on the way in", () => {
    expect(base32Decode("MZXW6YTBOI")).toEqual(bytes("foobar"));
  });

  it("rejects characters outside the alphabet, including = and 1", () => {
    for (const bad of ["MZXW6YTBOI=", "MZXW6YTBO1", "mzxw6ytboi!", "mzxw6ytboi*"]) {
      expect(() => base32Decode(bad)).toThrow(EncodingError);
    }
  });

  it("rejects a tail that cannot be a whole number of bytes", () => {
    for (const bad of ["m", "mzx", "mzxw6ytbo"]) {
      expect(() => base32Decode(bad)).toThrow(EncodingError);
    }
  });

  it("rejects a tail whose discarded bits were not zero, so a corrupted id is not read as a different id", () => {
    // "MY" is 'f' with two zero bits left over; "MF" is the same byte with them set.
    expect(base32Decode("MY")).toEqual(new Uint8Array([0x66]));
    expect(() => base32Decode("MF")).toThrow(EncodingError);
  });

  it("is the exact inverse of the encoder over a 256-byte sweep", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(base32Decode(base32Encode(all))).toEqual(all);
  });
});
