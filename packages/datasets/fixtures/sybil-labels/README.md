# Signed sybil-label fixture

80 synthetic wallets, 40 labelled human and 40 labelled sybil. Every label is a
`personal_sign` statement by the issuer in `issuer.txt` over exactly:

```
Crucible label attestation
wallet: 0x…
label: 0|1
issuedAt: N
expiry: N
```

`proofs.jsonl` holds those signatures; `corpus.jsonl` is the labeler's output; `sheet.jsonl` is
the unlabelled feature half a human would fill in. The private key is deliberately **not**
committed — the fixture is verifiable, not regenerable, and no production labeler key belongs
in this repository.

These wallets are synthetic (`0x000…000`, `0x000…001`, …). This is a fixture for the label
pipeline, not a claim about any real address.

**Labels are not trial verdicts.** `sheet.jsonl` carries features only; a slashed agent is not
a sybil, and `scripts/label-identity-corpus.mjs` never reads a verdict. The test
`packages/datasets/test/sybil-labels.test.ts` adds a row with a `slashed` verdict and no proof
and asserts the output corpus does not contain it.
