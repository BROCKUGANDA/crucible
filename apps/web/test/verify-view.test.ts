import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZERO_ADDRESS, isRevert, receiptView, type ReceiptRead } from "@/lib/verify-view";

/**
 * The verify page has to be able to say "no".
 *
 * `VerificationReceipt` is the artifact an integrator is told to check, and the page printed `—`
 * for a token that does not exist, for a read still in flight, for a chain it could not reach, and
 * for a build that was never given a receipt address at all — which is precisely the state this
 * deployment is in, since `/.well-known/crucible.json` publishes `verificationReceipt: null`. Token
 * 1, token 999 and a dead RPC looked identical. Four situations that mean different things to
 * different readers cannot share one glyph.
 *
 * The mapping is pure and asserted per state, so the distinction survives the next person who
 * tidies the markup.
 */

const READ = (over: Partial<ReceiptRead>): ReceiptRead => ({
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  typed: true,
  reading: false,
  ...over,
});

describe("which state the page may claim", () => {
  it("says idle when nobody has asked yet", () => {
    expect(receiptView(READ({ typed: false })).kind).toBe("idle");
  });

  it("says unconfigured before it says anything about a token", () => {
    // The zero address makes every query a call against no contract. Reporting that as "no such
    // receipt" would tell an integrator their token is missing when the deployment is missing.
    const view = receiptView(READ({ address: ZERO_ADDRESS, error: new Error("reverted") }));
    expect(view.kind).toBe("unconfigured");
  });

  it("says found when the chain named an owner", () => {
    const view = receiptView(READ({ owner: "0xAbC" }));
    expect(view).toMatchObject({ kind: "found", owner: "0xAbC", uri: null });
  });

  it("says absent when the chain answered and refused", () => {
    const view = receiptView(
      READ({ error: { name: "ContractFunctionRevertedError", shortMessage: "Execution reverted" } }),
    );
    expect(view.kind).toBe("absent");
  });

  it("says unreachable when the chain never answered", () => {
    const view = receiptView(READ({ error: { name: "HttpRequestError", message: "fetch failed" } }));
    expect(view.kind).toBe("unreachable");
    // The sentence an integrator reads must not claim anything about the token.
    expect(view.detail).not.toMatch(/no receipt was minted|does not exist/i);
  });

  it("says unreachable for an error it cannot classify", () => {
    expect(receiptView(READ({ error: "the socket closed" })).kind).toBe("unreachable");
  });

  it("says reading only while nothing has come back", () => {
    expect(receiptView(READ({ reading: true })).kind).toBe("reading");
  });

  it("refuses to print a bare em dash for a call that returned nothing", () => {
    // No error, no data, not pending: the read is over and empty. That is not a finding about the
    // token, and the page must not let it look like one.
    expect(receiptView(READ({})).kind).toBe("unreachable");
  });
});

describe("revert classification", () => {
  it.each([
    [{ name: "ContractFunctionRevertedError" }, true],
    [{ shortMessage: "The call reverted with an empty return value" }, true],
    [{ message: "Execution reverted for an unknown reason" }, true],
    [{ name: "HttpRequestError" }, false],
    [{ name: "ProviderRpcError", message: "window is not defined" }, false],
    [{ name: "UserRejectedRequestError" }, false],
    [{ message: "chain timed out after 10s" }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ])("classifies %j as revert=%s", (error, expected) => {
    expect(isRevert(error)).toBe(expected);
  });

  it("treats a wallet rejection as a failure to ask, not as an answer", () => {
    // A declined signature means nobody looked. Saying "no such receipt" here would be the
    // fabricated measurement this page was written to stop making.
    expect(receiptView(READ({ error: { name: "UserRejectedRequestError" } })).kind).toBe(
      "unreachable",
    );
  });
});

const PAGE = readFileSync(fileURLToPath(new URL("../src/app/verify/page.tsx", import.meta.url)), "utf8");

describe("the page is wired to the states, not to a ternary", () => {
  it("renders the found panel only from the found state", () => {
    expect(PAGE).toContain('view.kind === "found"');
  });

  it("keeps `owner ? … : \"—\"` out of the markup", () => {
    // That expression is the bug: one glyph for four situations.
    expect(PAGE).not.toMatch(/owner \? String\(owner\)/);
    expect(PAGE).not.toMatch(/uri \? String\(uri\)/);
  });

  it("states the outcome in a word as well as a value", () => {
    // Status never travels by colour alone, and here it does not travel by absence either.
    expect(PAGE).toContain("{view.kind}");
    expect(PAGE).toContain("{view.detail}");
  });

  it("carries the error and pending flags into the mapping", () => {
    expect(PAGE).toMatch(/error: ownerRead\.error \?\? uriRead\.error/);
    expect(PAGE).toMatch(/reading: ownerRead\.isPending \|\| uriRead\.isPending/);
  });
});
