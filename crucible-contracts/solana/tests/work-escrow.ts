import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "node:crypto";
import { assert } from "chai";
import type { WorkEscrow } from "../target/types/work_escrow";

/**
 * The end-to-end suite against a localnet validator (gate 716; setup list step 9).
 *
 * Every happy path asserts EXACT balances — the same rows the Foundry suite
 * asserts on the EVM side and the host tests assert in math.rs. Three
 * implementations of one flow table; all three must agree to the lamport.
 */

const REWARD = 10_000n;
const STAKE = 2_000n; // floor is 1_000 below, so this clears it
const EST_COST = 1_000n;
const FEE = (REWARD * 500n) / 10_000n; // 5% — math.rs and RewardMath.sol agree

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as AnchorProvider;
const program = anchor.workspace.WorkEscrow as Program<WorkEscrow>;

const funder = Keypair.generate();
const worker = Keypair.generate();
const treasury = Keypair.generate();
const disputer = Keypair.generate();

let mint: PublicKey;
let funderAta: PublicKey;
let workerAta: PublicKey;
let treasuryAta: PublicKey;
let disputerAta: PublicKey;

/** Verdict body -> sha256, the gate-712 binding: same bytes noble would make. */
function verdictHash(body: unknown): Buffer {
  return createHash("sha256").update(Buffer.from(JSON.stringify(body))).digest();
}

async function airdropLamports(who: PublicKey, sol = 10): Promise<void> {
  const sig = await provider.connection.requestAirdrop(who, sol * LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

async function balanceOf(ata: PublicKey): Promise<bigint> {
  return (await getAccount(provider.connection, ata)).amount;
}

function escrowPda(workId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), worker.publicKey.toBuffer(), workId.toArrayLike(Buffer, "le", 8)],
    program.programId,
  );
}

function vaultPda(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrow.toBuffer()],
    program.programId,
  );
}

async function openEscrow(workId: BN, reward = REWARD, expirySlots = new BN(2_000_000)) {
  const [escrow] = escrowPda(workId);
  const [vault] = vaultPda(escrow);
  return program.methods
    .openEscrow(workId, new BN(EST_COST.toString()), new BN(reward.toString()), expirySlots)
    .accounts({
      funder: funder.publicKey,
      worker: worker.publicKey,
      resolver: funder.publicKey, // demo: the funder acts as committee
      mint,
      escrow,
      vault,
      funderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([funder])
    .rpc();
}

async function postWork(workId: BN, stake = STAKE, vh?: Buffer) {
  const claim = vh ?? verdictHash({ verdict: "PASS", model: "stub", probeBank: "v1" });
  const [escrow] = escrowPda(workId);
  const [vault] = vaultPda(escrow);
  return program.methods
    .postWork(workId, new BN(stake.toString()), [...claim], [...claim])
    .accounts({
      worker: worker.publicKey,
      escrow,
      vault,
      mint,
      workerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([worker])
    .rpc();
}

async function settle(workId: BN, pass: boolean, claim: Buffer, caller = funder) {
  const [escrow] = escrowPda(workId);
  const [vault] = vaultPda(escrow);
  return program.methods
    .settle(workId, pass, [...claim])
    .accounts({
      caller: caller.publicKey,
      worker: worker.publicKey,
      escrow,
      vault,
      mint,
      workerAta,
      funderAta,
      treasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([caller])
    .rpc();
}

async function dispute(workId: BN, fee: bigint, who = disputer) {
  const [escrow] = escrowPda(workId);
  const [vault] = vaultPda(escrow);
  return program.methods
    .dispute(workId, new BN(fee.toString()))
    .accounts({
      disputer: who.publicKey,
      worker: worker.publicKey,
      escrow,
      vault,
      mint,
      disputerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([who])
    .rpc();
}

async function resolveDispute(workId: BN, workerWon: boolean, asResolver = funder) {
  const [escrow] = escrowPda(workId);
  const [vault] = vaultPda(escrow);
  return program.methods
    .resolveDispute(workId, workerWon)
    .accounts({
      resolver: asResolver.publicKey,
      worker: worker.publicKey,
      escrow,
      vault,
      mint,
      workerAta,
      funderAta,
      treasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([asResolver])
    .rpc();
}

async function expectReject(p: Promise<string>, nameMatch: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!nameMatch.test(msg)) {
      throw new Error(`rejected, but with the wrong code: ${msg}`);
    }
    return;
  }
  throw new Error(`expected rejection (${nameMatch}), transaction succeeded`);
}

before(async () => {
  await Promise.all(
    [funder, worker, treasury, disputer].map((k) => airdropLamports(k.publicKey)),
  );

  mint = await createMint(
    provider.connection,
    funder,
    funder.publicKey,
    null,
    6,
  );
  funderAta = (
    await getOrCreateAssociatedTokenAccount(provider.connection, funder, mint, funder.publicKey)
  ).address;
  workerAta = (
    await getOrCreateAssociatedTokenAccount(provider.connection, funder, mint, worker.publicKey)
  ).address;
  treasuryAta = (
    await getOrCreateAssociatedTokenAccount(provider.connection, funder, mint, treasury.publicKey)
  ).address;
  disputerAta = (
    await getOrCreateAssociatedTokenAccount(provider.connection, funder, mint, disputer.publicKey)
  ).address;

  await mintTo(provider.connection, funder, mint, funderAta, funder, 1_000_000n);
  await mintTo(provider.connection, funder, mint, workerAta, funder, 1_000_000n);
  await mintTo(provider.connection, funder, mint, disputerAta, funder, 1_000_000n);
});

describe("work-escrow — the flow table, end to end", () => {
  it("open -> post -> settle(PASS): worker takes reward-fee + stake, treasury takes the fee", async () => {
    const workId = new BN(1);
    await openEscrow(workId);
    await postWork(workId);

    const w0 = await balanceOf(workerAta);
    const t0 = await balanceOf(treasuryAta);
    const claim = verdictHash({ verdict: "PASS", model: "stub", probeBank: "v1" });
    await settle(workId, true, claim);

    assert.equal(
      (await balanceOf(workerAta)) - w0,
      REWARD - FEE + STAKE,
      "worker payout is workerShare + stake",
    );
    assert.equal((await balanceOf(treasuryAta)) - t0, FEE, "treasury takes exactly the frozen fee");

    const [escrow] = escrowPda(workId);
    const [vault] = vaultPda(escrow);
    const escrowData = await program.account.escrow.fetch(escrow);
    // deepEqual, not equal: the enum decodes to a fresh object each fetch, and
    // `equal` compares identity — two `{ settled: {} }` are never `===`.
    assert.deepEqual(escrowData.status, { settled: {} });
    assert.equal((await balanceOf(vault)).toString(), "0", "vault emptied — the pot partitioned once");
    assert.ok(
      escrowData.deposited.eq(escrowData.withdrawn.add(escrowData.swept)),
      "ghost ledger closes: deposited == withdrawn + swept",
    );
  });

  it("settle(FAIL): funder refunded in full incl. the fee; stake slashed 50/50", async () => {
    const workId = new BN(2);
    await openEscrow(workId);
    await postWork(workId);

    const f0 = await balanceOf(funderAta);
    const t0 = await balanceOf(treasuryAta);
    await settle(workId, false, Buffer.alloc(32));

    assert.equal((await balanceOf(funderAta)) - f0, REWARD + STAKE / 2n, "funder: reward + half stake");
    assert.equal((await balanceOf(treasuryAta)) - t0, STAKE - STAKE / 2n, "treasury: other half of stake");
  });

  it("dispute round, worker wins: full restitution + dispute fee to treasury", async () => {
    const workId = new BN(3);
    await openEscrow(workId);
    await postWork(workId);

    const DISPUTE_FEE = 300n;
    await dispute(workId, DISPUTE_FEE);

    const w0 = await balanceOf(workerAta);
    const t0 = await balanceOf(treasuryAta);
    await resolveDispute(workId, true);

    assert.equal((await balanceOf(workerAta)) - w0, REWARD + STAKE, "overturn: full restitution");
    assert.equal((await balanceOf(treasuryAta)) - t0, DISPUTE_FEE, "dispute fee forfeited to treasury");
  });

  it("dispute round, worker loses: the fail row + the fee to treasury", async () => {
    const workId = new BN(4);
    await openEscrow(workId);
    await postWork(workId);

    const DISPUTE_FEE = 300n;
    await dispute(workId, DISPUTE_FEE);

    const f0 = await balanceOf(funderAta);
    const t0 = await balanceOf(treasuryAta);
    await resolveDispute(workId, false);

    assert.equal((await balanceOf(funderAta)) - f0, REWARD + STAKE / 2n);
    assert.equal((await balanceOf(treasuryAta)) - t0, STAKE - STAKE / 2n + DISPUTE_FEE);
  });

  it("rejection: settle before post is an illegal transition", async () => {
    const workId = new BN(5);
    await openEscrow(workId);
    await expectReject(settle(workId, false, Buffer.alloc(32)), /IllegalTransition|illegal/i);
  });

  it("rejection: settle PASS with the wrong claim hash", async () => {
    const workId = new BN(6);
    await openEscrow(workId);
    await postWork(workId);
    await expectReject(
      settle(workId, true, verdictHash({ verdict: "PASS", model: "EVIL", probeBank: "v1" })),
      /VerdictHashMismatch|hash/i,
    );
  });

  it("rejection: settle is blocked while a dispute is open", async () => {
    const workId = new BN(7);
    await openEscrow(workId);
    await postWork(workId);
    await dispute(workId, 300n);
    const claim = verdictHash({ verdict: "PASS", model: "stub", probeBank: "v1" });
    await expectReject(settle(workId, true, claim), /DisputeOpen|dispute/i);
  });

  it("rejection: stake below the published floor", async () => {
    const workId = new BN(8);
    await openEscrow(workId);
    await expectReject(postWork(workId, EST_COST - 1n), /StakeBelowFloor|floor/i);
  });

  it("rejection: expire before the deadline has passed", async () => {
    const workId = new BN(9);
    await openEscrow(workId, REWARD, new BN(2_000_000));
    const [escrow] = escrowPda(workId);
    const [vault] = vaultPda(escrow);
    await expectReject(
      program.methods
        .expire(workId)
        .accounts({
          caller: funder.publicKey,
          worker: worker.publicKey,
          escrow,
          vault,
          mint,
          workerAta,
          funderAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([funder])
        .rpc(),
      /DeadlineNotPassed|deadline/i,
    );
  });

  it("expire after the deadline: funder refunded everything incl. the frozen fee, stake back to worker", async () => {
    const workId = new BN(10);
    await openEscrow(workId, REWARD, new BN(3)); // a few slots of lifetime
    await postWork(workId);

    const [escrow] = escrowPda(workId);
    const expirySlot = (await program.account.escrow.fetch(escrow)).expirySlot;
    // localnet mines slots continuously; wait for the deadline to pass
    for (let i = 0; i < 120; i++) {
      const slot = await provider.connection.getSlot("confirmed");
      if (new BN(slot).gte(expirySlot)) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    const f0 = await balanceOf(funderAta);
    const w0 = await balanceOf(workerAta);
    const [vault] = vaultPda(escrow);
    await program.methods
      .expire(workId)
      .accounts({
        caller: funder.publicKey,
        worker: worker.publicKey,
        escrow,
        vault,
        mint,
        workerAta,
        funderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([funder])
      .rpc();

    assert.equal((await balanceOf(funderAta)) - f0, REWARD, "funder: full reward, fee included");
    assert.equal((await balanceOf(workerAta)) - w0, STAKE, "worker: stake back");
  });
});
