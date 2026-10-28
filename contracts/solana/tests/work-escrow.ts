import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WorkEscrow } from "../target/types/work_escrow";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "@coral-xyz/anchor";

describe("work-escrow", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.WorkEscrow as Program<WorkEscrow>;

  const workId = 1n;
  const reward = anchor.web3.LAMPORTS_PER_SOL; // 1 SOL
  const stake = anchor.web3.LAMPORTS_PER_SOL / 10; // 0.1 SOL
  const suiteRoot = new Uint8Array(32).fill(0x42);
  const deadlineSlot = 1_000_000;

  let client: Keypair;
  let worker: Keypair;
  let escrowPDA: PublicKey;
  let escrowBump: number;

  before(async () => {
    client = Keypair.generate();
    worker = Keypair.generate();

    // Airdrop to client
    const sig = await provider.connection.requestAirdrop(
      client.publicKey,
      anchor.web3.LAMPORTS_PER_SOL * 10
    );
    await provider.connection.confirmTransaction(sig);

    // Derive escrow PDA
    [escrowPDA, escrowBump] = await PublicKey.findProgramAddress(
      [
        Buffer.from("escrow"),
        worker.publicKey.toBuffer(),
        Buffer.from(workId.toString()),
      ],
      program.programId
    );
  });

  it("opens an escrow", async () => {
    const tx = await program.methods
      .open({
        workId: Number(workId),
        reward: new anchor.BN(reward),
        stake: new anchor.BN(stake),
        suiteRoot: suiteRoot,
        deadlineSlot: new anchor.BN(deadlineSlot),
      })
      .accounts({
        client: client.publicKey,
        worker: worker.publicKey,
        escrow: escrowPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPDA);
    assert.equal(escrow.status, "open");
    assert.equal(escrow.reward.toString(), reward.toString());
    assert.equal(escrow.stake.toString(), stake.toString());
  });

  it("rejects stake below floor", async () => {
    try {
      await program.methods
        .open({
          workId: 2,
          reward: new anchor.BN(reward),
          stake: new anchor.BN(1), // below K_FLOOR=3
          suiteRoot: suiteRoot,
          deadlineSlot: new anchor.BN(deadlineSlot),
        })
        .accounts({
          client: client.publicKey,
          worker: worker.publicKey,
          escrow: escrowPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([client])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.message, "StakeFloorViolation");
    }
  });

  it("posts work and settles pass", async () => {
    const resultHash = new Uint8Array(32).fill(0xab);
    const verdictHash = new Uint8Array(32).fill(0xcd);
    await program.methods
      .postWork({
        workId: Number(workId),
        resultHash,
        verdictHash,
      })
      .accounts({
        worker: worker.publicKey,
        escrow: escrowPDA,
      })
      .signers([worker])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPDA);
    assert.equal(escrow.status, "running");

    await program.methods
      .settle({
        workId: Number(workId),
        verdict: 1,
        verdictHash,
      })
      .accounts({
        authority: client.publicKey,
        escrow: escrowPDA,
      })
      .signers([client])
      .rpc();

    const settled = await program.account.escrow.fetch(escrowPDA);
    assert.equal(settled.status, "settledPass");
  });

  it("rejects double settle", async () => {
    try {
      await program.methods
        .settle({
          workId: Number(workId),
          verdict: 1,
          verdictHash: new Uint8Array(32).fill(0xef),
        })
        .accounts({
          authority: client.publicKey,
          escrow: escrowPDA,
        })
        .signers([client])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.message, "NotRunning");
    }
  });

  it("expires refunds the client", async () => {
    // Open a fresh escrow that never gets work posted
    const workId2 = 2n;
    const [expirePDA] = await PublicKey.findProgramAddress(
      [
        Buffer.from("escrow"),
        worker.publicKey.toBuffer(),
        Buffer.from(workId2.toString()),
      ],
      program.programId
    );

    await program.methods
      .open({
        workId: Number(workId2),
        reward: new anchor.BN(reward),
        stake: new anchor.BN(stake),
        suiteRoot: suiteRoot,
        deadlineSlot: new anchor.BN(1), // already passed
      })
      .accounts({
        client: client.publicKey,
        worker: worker.publicKey,
        escrow: expirePDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    await program.methods
      .expire({})
      .accounts({
        client: client.publicKey,
        escrow: expirePDA,
      })
      .signers([client])
      .rpc();

    const expired = await program.account.escrow.fetch(expirePDA);
    assert.equal(expired.status, "expired");
  });
});
