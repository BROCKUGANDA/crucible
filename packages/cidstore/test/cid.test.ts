import { describe, expect, it } from "vitest";
import {
  CidError,
  base32Encode,
  bytesEqual,
  cid,
  cidFromDigest,
  cidV0,
  cidV1Raw,
  decodeCid,
  isCid,
  multihash,
  sha256,
  toHex,
  tryDecodeCid,
  verifyCid,
} from "../src/index.js";

/**
 * Every expected id below was produced by `multiformats` 9.9.0 — the reference IPFS
 * implementation, `CID.createV0(sha256(bytes))` and `CID.createV1(0x55, sha256(bytes))` —
 * and every digest was produced by OpenSSL 3.0.18 as well as by node's `crypto`. They were
 * copied out of that comparison, not out of a run of this package, so a wrong implementation
 * fails these tests rather than rewriting them.
 */

/** The two shapes `packages/smith-sdk/src/types.ts` defines as the only accepted CIDs. */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{58}$/;

const HELLO = "hello world";

/** A CIDv1 text form from raw framing bytes, so a test can build right-shaped wrong ids. */
const framed = (bytes: number[]): string => `b${base32Encode(new Uint8Array(bytes))}`;

const VECTORS: { content: string; digest: string; v0: string; v1: string }[] = [
  {
    content: "",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    v0: "QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n",
    v1: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  },
  {
    content: HELLO,
    digest: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    v0: "QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4",
    v1: "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
  },
  {
    content: "foo",
    digest: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    v0: "QmRJzsvyCQyizr73Gmms8ZRtvNxmgqumxc2KUp71dfEmoj",
    v1: "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy",
  },
  {
    content: "this is a test",
    digest: "2e99758548972a8e8822ad47fa1017ff72f06f3ff6a016851f45c398732bc50c",
    v0: "QmRUZBbv8szRR2J66MXECb4P5au83WGhrWg6TnDsEsM76s",
    v1: "bafkreibotf2yksexfkhiqivni75baf77olyg6p7wualikh2fyomhgk6fbq",
  },
  {
    content: "héllo → ω 中文",
    digest: "ca079c68ef0779d2efac09ffdc2b95f1c2d7e2f236e9c838a8b7df1cf7b8fbe7",
    v0: "QmbwHo6thsSJFKb75uAdAEkXumpdx8hcujaKGyHEgXESNS",
    v1: "bafkreigka6ogr3yhphjo7laj77ocxfpryll6f4rw5hedrkfx34oppoh344",
  },
];

describe("sha256", () => {
  it("matches OpenSSL on the published digests", () => {
    for (const vector of VECTORS) expect(toHex(sha256(vector.content))).toBe(vector.digest);
  });

  it("hashes the bytes, not the UTF-16 code units, and agrees with a Uint8Array input", () => {
    const nonAscii = VECTORS[4]!;
    expect(toHex(sha256(nonAscii.content))).toBe(nonAscii.digest);
    expect(toHex(sha256(new TextEncoder().encode(nonAscii.content)))).toBe(nonAscii.digest);
    expect(toHex(sha256("é"))).not.toBe(toHex(sha256("Ã©")));
  });
});

describe("multihash framing", () => {
  it("is 0x12 0x20 followed by the digest, which is what makes it a sha2-256 multihash", () => {
    for (const vector of VECTORS) {
      const framed = multihash(vector.content);
      expect(framed).toHaveLength(34);
      expect(framed[0]).toBe(0x12);
      expect(framed[1]).toBe(0x20);
      expect(toHex(framed.subarray(2))).toBe(vector.digest);
    }
  });
});

describe("cidV0", () => {
  it("is the reference implementation's CIDv0 for the same bytes", () => {
    for (const vector of VECTORS) expect(cidV0(vector.content)).toBe(vector.v0);
  });

  it("is 46 characters, starts with Qm and passes the shape the SDK accepts", () => {
    for (const vector of VECTORS) {
      expect(cidV0(vector.content)).toHaveLength(46);
      expect(cidV0(vector.content).startsWith("Qm")).toBe(true);
      expect(CID_V0.test(cidV0(vector.content))).toBe(true);
      expect(CID_V1.test(cidV0(vector.content))).toBe(false);
    }
  });
});

describe("cidV1Raw", () => {
  it("is the reference implementation's raw-codec CIDv1 for the same bytes", () => {
    for (const vector of VECTORS) expect(cidV1Raw(vector.content)).toBe(vector.v1);
  });

  it("is the multibase 'b' form of version 1, codec 0x55 and the multihash", () => {
    for (const vector of VECTORS) {
      const text = cidV1Raw(vector.content);
      expect(text).toHaveLength(59);
      // raw leaves are "bafkrei"; "bafybei" would be a claim that the bytes are dag-pb.
      expect(text.startsWith("bafkrei")).toBe(true);
      expect(CID_V1.test(text)).toBe(true);
      expect(CID_V0.test(text)).toBe(false);
      expect(text).toBe(`b${base32Encode(new Uint8Array([0x01, 0x55, ...multihash(vector.content)]))}`);
    }
  });

  it("takes the version from the caller without changing what is stored", () => {
    for (const vector of VECTORS) {
      expect(cid(vector.content, "v0")).toBe(vector.v0);
      expect(cid(vector.content, "v1")).toBe(vector.v1);
    }
  });
});

describe("the two spellings are one identity", () => {
  it("decode to the same digest", () => {
    for (const vector of VECTORS) {
      expect(toHex(decodeCid(vector.v0).digest)).toBe(vector.digest);
      expect(toHex(decodeCid(vector.v1).digest)).toBe(vector.digest);
    }
  });

  it("can be rebuilt from the digest alone", () => {
    for (const vector of VECTORS) {
      expect(cidFromDigest(vector.digest, "v0")).toBe(vector.v0);
      expect(cidFromDigest(vector.digest, "v1")).toBe(vector.v1);
      expect(cidFromDigest(sha256(vector.content), "v1")).toBe(vector.v1);
    }
  });

  it("refuses a digest that is not sha2-256 sized", () => {
    expect(() => cidFromDigest("aabb", "v1")).toThrow(CidError);
  });
});

describe("decodeCid", () => {
  it("reports version and codec the way the reference implementation reads them", () => {
    // These two strings are the fixtures already used across this repo's tests. They are
    // well-formed dag-pb CIDv1s; the second carries the digest of *empty* content, which is
    // why a shape check alone cannot tell a real id from a borrowed one.
    const borrowed = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const other = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    expect(tryDecodeCid(borrowed)).toMatchObject({ version: 1, codec: 0x70 });
    expect(toHex(decodeCid(borrowed).digest)).toBe(VECTORS[0]!.digest);
    expect(toHex(decodeCid(other).digest)).toBe("c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a");

    expect(decodeCid(VECTORS[1]!.v0)).toMatchObject({ version: 0, codec: 0x70 });
    expect(decodeCid(VECTORS[1]!.v1)).toMatchObject({ version: 1, codec: 0x55 });
  });

  it("throws, rather than returning garbage, for anything that is not a sha2-256 CID", () => {
    const bad = [
      "",
      "Qm",
      "b",
      "not a cid",
      VECTORS[0]!.v0.slice(0, -1),
      `b${"1".repeat(58)}`,
      `b${"a".repeat(57)}=`,
      "Qmbase58hasnoOIlcharacters0000000000000000000000",
    ];
    for (const value of bad) {
      expect([value, tryDecodeCid(value)]).toEqual([value, null]);
      expect(() => decodeCid(value)).toThrow(CidError);
    }
  });

  it("checks the framing, not just the character set", () => {
    // Right length, right alphabet, wrong bytes inside: a CIDv1 declaring version 2, and
    // one whose multihash is not sha2-256. Both look exactly like ids to a regex.
    const wrongVersion = framed([0x02, 0x55, 0x12, 0x20, ...sha256(HELLO)]);
    const wrongHash = framed([0x01, 0x55, 0x13, 0x20, ...sha256(HELLO)]);

    expect(CID_V1.test(wrongVersion)).toBe(true);
    expect(CID_V1.test(wrongHash)).toBe(true);
    expect(tryDecodeCid(wrongVersion)).toBeNull();
    expect(tryDecodeCid(wrongHash)).toBeNull();
    expect(isCid(wrongVersion)).toBe(false);
    expect(isCid(wrongHash)).toBe(false);
    expect(verifyCid(wrongVersion, HELLO)).toBe(false);
  });

  it("accepts a well-formed id whose digest is all zeros, because nothing is stored under it either way", () => {
    // Structural validity and presence are different questions: this is a real sha2-256
    // multihash, it just is not the hash of anything in particular.
    const zeroed = framed([0x01, 0x55, 0x12, 0x20, ...new Uint8Array(32)]);
    expect(isCid(zeroed)).toBe(true);
    expect(toHex(decodeCid(zeroed).digest)).toBe("00".repeat(32));
    expect(verifyCid(zeroed, HELLO)).toBe(false);
  });

  it("rejects a right-shaped id whose multihash is not sha2-256", () => {
    // version 1, raw codec, but an *identity* multihash: 59 lowercase base32 characters, so
    // the SDK's regex would accept it. It is not a content id anyone can fetch.
    const identity = new Uint8Array([0x01, 0x55, 0x00, 0x20, ...new Uint8Array(32).fill(9)]);
    const text = `b${base32Encode(identity)}`;
    expect(CID_V1.test(text)).toBe(true);
    expect(isCid(text)).toBe(false);
    expect(verifyCid(text, "anything")).toBe(false);
  });

  it("rejects the near-misses the shape check is famous for", () => {
    const cases: [string, boolean][] = [
      [VECTORS[0]!.v0, true],
      [VECTORS[0]!.v1, true],
      [`${VECTORS[0]!.v0}x`, false],
      [VECTORS[0]!.v0.slice(0, 45), false],
      [VECTORS[0]!.v1.toUpperCase(), false],
      [`bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyk`, false],
      [`b0fkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e`, false],
      ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", true],
      ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbd", false],
      ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdGz", false],
    ];
    for (const [value, expected] of cases) expect([value, isCid(value)]).toEqual([value, expected]);
  });
});

describe("isCid", () => {
  it("accepts both real spellings and nothing else", () => {
    for (const vector of VECTORS) {
      expect(isCid(vector.v0)).toBe(true);
      expect(isCid(vector.v1)).toBe(true);
    }
    for (const bad of ["", " ", "Qm", "bafz", "1", "0".repeat(46), "b" + "a".repeat(58)]) {
      expect(isCid(bad)).toBe(false);
    }
  });

  it("is false for a string that is only close to the alphabet", () => {
    // 'l' and '0' are not in base58; '1' and '9' are not in base32.
    expect(isCid(`Qm${"l".repeat(44)}`)).toBe(false);
    expect(isCid(`Qm${"0".repeat(44)}`)).toBe(false);
    expect(isCid(`b${"1".repeat(58)}`)).toBe(false);
    expect(isCid(`b${"9".repeat(58)}`)).toBe(false);
    expect(isCid(`b${"a".repeat(57)}=`)).toBe(false);
  });
});

describe("verifyCid", () => {
  it("is true for the content the id names, in either spelling", () => {
    for (const vector of VECTORS) {
      expect(verifyCid(vector.v0, vector.content)).toBe(true);
      expect(verifyCid(vector.v1, vector.content)).toBe(true);
      expect(verifyCid(vector.v1, new TextEncoder().encode(vector.content))).toBe(true);
    }
  });

  it("is false when one byte of the content changed", () => {
    for (const vector of VECTORS.filter((v) => v.content.length > 0)) {
      expect(verifyCid(vector.v1, `${vector.content}x`)).toBe(false);
      expect(verifyCid(vector.v1, vector.content.slice(0, -1))).toBe(false);
    }
  });

  it("is false across a mismatched pair rather than for either alone", () => {
    expect(verifyCid(VECTORS[1]!.v1, VECTORS[2]!.content)).toBe(false);
    expect(verifyCid(VECTORS[2]!.v0, VECTORS[1]!.content)).toBe(false);
  });

  it("is false for an id it cannot parse, and for an empty id", () => {
    expect(verifyCid("", HELLO)).toBe(false);
    expect(verifyCid("bafkrei", HELLO)).toBe(false);
    expect(verifyCid(`${VECTORS[1]!.v0.slice(0, -1)}a`, HELLO)).toBe(false);
  });

  it("does not confuse two contents that differ only in a trailing newline", () => {
    const without = cidV1Raw("result\n");
    const withCrlf = cidV1Raw("result\r\n");
    expect(verifyCid(without, "result\n")).toBe(true);
    expect(verifyCid(without, "result\r\n")).toBe(false);
    expect(verifyCid(withCrlf, "result\r\n")).toBe(true);
  });
});

describe("bytesEqual", () => {
  it("compares content, not identity or length alone", () => {
    const a = sha256(HELLO);
    expect(bytesEqual(a, sha256(HELLO))).toBe(true);
    expect(bytesEqual(a, new Uint8Array(a.length))).toBe(false);
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(bytesEqual(a, a.slice(0, 31))).toBe(false);
    expect(bytesEqual(new Uint8Array([0]), new Uint8Array([1]))).toBe(false);
  });
});
