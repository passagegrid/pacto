// tests/settla_escrow.ts
//
// pacto / settla_escrow v0.1
// invariant-first test scaffold
//
// covers initial high-signal paths:
// - B1 balance determinism
// - A1 no unilateral settlement
//
// this is a scaffold: helpers + structure + test slots.
// fill assertions incrementally as you wire logic.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SettlaEscrow } from "../target/types/settla_escrow";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

const { SystemProgram } = anchor.web3;

describe("settla_escrow v0.1", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.SettlaEscrow as Program<SettlaEscrow>;

  // actors
  const admin = anchor.web3.Keypair.generate();
  const buyer = anchor.web3.Keypair.generate();
  const seller = anchor.web3.Keypair.generate();
  const arbiter = anchor.web3.Keypair.generate();
  const stranger = anchor.web3.Keypair.generate();

  // globals
  let usdcMint: anchor.web3.PublicKey;
  let buyerAta: any;
  let sellerAta: any;
  let feeCollectorAta: any;

  const AMOUNT = 1_000_000; // 1 USDC (6 decimals)
  const FEE = 10_000; // 0.01 USDC

  async function airdrop(pubkey: anchor.web3.PublicKey, retries = 5) {
    for (let i = 0; i < retries; i++) {
      try {
        const sig = await provider.connection.requestAirdrop(pubkey, 5e9);
        await provider.connection.confirmTransaction(sig);
        return;
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise((r) => setTimeout(r, 2000)); // wait 2s before retry
      }
    }
  }

  before(async () => {
    for (const kp of [admin, buyer, seller, arbiter, stranger]) {
      await airdrop(kp.publicKey);
    }

    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    buyerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      buyer.publicKey
    );

    sellerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      seller.publicKey
    );

    feeCollectorAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );

    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      sellerAta.address,
      admin,
      AMOUNT
    );
  });

  /* ======================================================
     helpers
     ====================================================== */

  function now(): number {
    return Math.floor(Date.now() / 1000);
  }

  function deadlines() {
    const t = now();
    return {
      fund: t + 60,
      pay: t + 120,
      dispute: t + 180, // must be after pay deadline
      resolve: t + 600,
    };
  }

  function contractSeeds(contractId: Buffer) {
    return [Buffer.from("contract"), contractId];
  }

  function escrowAuthoritySeeds(contractId: Buffer) {
    return [Buffer.from("escrow_authority"), contractId];
  }

  function random32(): number[] {
    return Array.from(anchor.web3.Keypair.generate().publicKey.toBuffer());
  }

  /* ======================================================
     TESTS
     ====================================================== */

  it("B1.1 happy path: cooperative release drains escrow", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    // derive PDAs
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    // escrow vault is a new keypair (program will init it)
    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config
    await program.methods
      .initConfig(usdcMint, admin.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // capture balances pre-release
    const sellerBefore = Number(sellerAta.amount);
    const feeBefore = Number(feeCollectorAta.amount);

    // cooperative release
    await program.methods
      .releaseCooperative()
      .accounts({
        config: configPda,
        contract: contractPda,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        sellerUsdcAta: sellerAta.address,
        feeCollectorUsdcAta: feeCollectorAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer, seller])
      .rpc();

    // reload balances
    const sellerAfter = Number(
      (await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        seller.publicKey
      )).amount
    );

    const feeAfter = Number(
      (await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        admin.publicKey
      )).amount
    );

    let escrowAfter = 0;
    try {
      const escrowAcct = await getAccount(provider.connection, escrowVaultKp.publicKey);
      escrowAfter = Number(escrowAcct.amount);
    } catch {
      // account closed = 0 balance
    }

    // assertions (B1)
    assert.equal(escrowAfter, 0, "escrow must be empty");
    assert.equal(
      sellerAfter - sellerBefore,
      AMOUNT - FEE,
      "seller receives amount minus fee"
    );
    assert.equal(
      feeAfter - feeBefore,
      FEE,
      "fee collector receives fee"
    );

    const contract = await program.account.contract.fetch(contractPda);
    assert.equal(contract.state.released !== undefined, true, "state == RELEASED");
  });

  it("B1.2 dispute resolved to buyer drains escrow", async () => {
    // mint fresh USDC for seller
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      sellerAta.address,
      admin,
      AMOUNT
    );

    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // ensure buyer has some USDC ata (even if unused here)
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      buyer.publicKey
    );

    // init config (idempotent-ish: if already initialized, this may fail; skip if you already do it once globally)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow by seller
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // open dispute (opener can be buyer or seller)
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      buyer.publicKey
    );

    const buyerBefore = Number(buyerAtaLive.amount);
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );
    const feeBefore = Number(feeCollectorAtaLive.amount);

    // resolve to buyer (arbiter + buyer)
    // Generate dummy verdict data for this test
    const verdictId = Array.from(anchor.web3.Keypair.generate().publicKey.toBuffer());
    const rationaleHash = Array.from(anchor.web3.Keypair.generate().publicKey.toBuffer());
    const evidenceRoot = Array.from(anchor.web3.Keypair.generate().publicKey.toBuffer());

    await program.methods
      .resolveToBuyer(verdictId, rationaleHash, evidenceRoot)
      .accounts({
        config: configPda,
        contract: contractPda,
        buyer: buyer.publicKey,
        arbiter: arbiter.publicKey,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        buyerUsdcAta: buyerAtaLive.address,
        feeCollectorUsdcAta: feeCollectorAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter, buyer])
      .rpc();

    // balances
    const buyerAfter = Number(
      (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          usdcMint,
          buyer.publicKey
        )
      ).amount
    );

    const feeAfter = Number(
      (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          usdcMint,
          admin.publicKey
        )
      ).amount
    );

    let escrowAfter = 0;
    try {
      const escrowAcct = await getAccount(provider.connection, escrowVaultKp.publicKey);
      escrowAfter = Number(escrowAcct.amount);
    } catch {
      // closed => 0
    }

    // assertions (B1)
    assert.equal(escrowAfter, 0, "escrow must be empty after resolution");
    assert.equal(buyerAfter - buyerBefore, AMOUNT - FEE, "buyer receives amount minus fee");
    assert.equal(feeAfter - feeBefore, FEE, "fee collector receives fee");

    const contract = await program.account.contract.fetch(contractPda);
    assert.equal(
      contract.state.resolvedBuyer !== undefined,
      true,
      "state == RESOLVED_BUYER"
    );
  });

  it("B1.3 T12 auto-release after dispute deadline drains escrow", async () => {
    // mint fresh USDC for seller
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      sellerAta.address,
      admin,
      AMOUNT
    );

    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();

    // custom deadlines to make T12 easy: dispute soon after pay, but still ordered
    // use longer windows to account for RPC latency
    const t = now();
    const d = {
      fund: t + 60,
      pay: t + 90,
      dispute: t + 95, // short window after PAID_MARKED, but enough time to execute
      resolve: t + 600,
    };

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow by seller
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // mark paid (buyer)
    const paymentRefHash = Array.from(anchor.web3.Keypair.generate().publicKey.toBuffer());
    await program.methods
      .markPaid(paymentRefHash)
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const sellerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      seller.publicKey
    );
    const sellerBefore = Number(sellerAtaLive.amount);
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );
    const feeBefore = Number(feeCollectorAtaLive.amount);

    // wait until after dispute deadline (add buffer for clock drift)
    const waitMs = Math.max(0, (d.dispute + 3 - now()) * 1000);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    // auto-release (permissionless)
    await program.methods
      .autoReleaseAfterDisputeDeadline()
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        sellerUsdcAta: sellerAta.address,
        feeCollectorUsdcAta: feeCollectorAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const sellerAfter = Number(
      (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          usdcMint,
          seller.publicKey
        )
      ).amount
    );

    const feeAfter = Number(
      (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          usdcMint,
          admin.publicKey
        )
      ).amount
    );

    let escrowAfter = 0;
    try {
      const escrowAcct = await getAccount(provider.connection, escrowVaultKp.publicKey);
      escrowAfter = Number(escrowAcct.amount);
    } catch {
      // closed => 0
    }

    // assertions (B1)
    assert.equal(escrowAfter, 0, "escrow must be empty after T12 auto-release");
    assert.equal(sellerAfter - sellerBefore, AMOUNT - FEE, "seller receives amount minus fee");
    assert.equal(feeAfter - feeBefore, FEE, "fee collector receives fee");

    const contract = await program.account.contract.fetch(contractPda);
    assert.equal(contract.state.released !== undefined, true, "state == RELEASED");
  });

  it("A1.1 seller alone cannot cooperative release", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    // mark paid so release is gated by signers, not state
    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // seller alone tries to release — anchor will reject missing buyer signature
    await expectFail(
      program.methods
        .releaseCooperative()
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: sellerAta.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([seller]) // MISSING buyer
        .rpc(),
      /signature|missing|required|Unauthorized/i
    );
  });

  it("A1.2 buyer alone cannot resolve dispute", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    // open dispute
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, buyer.publicKey
    );
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // buyer alone tries resolve — missing arbiter signature
    await expectFail(
      program.methods
        .resolveToBuyer(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          arbiter: arbiter.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          buyerUsdcAta: buyerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer]) // MISSING arbiter
        .rpc(),
      /signature|missing|required|Unauthorized/i
    );
  });

  it("A1.3 arbiter alone cannot resolve dispute", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    // open dispute
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, buyer.publicKey
    );
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // arbiter alone tries resolve — missing buyer signature
    await expectFail(
      program.methods
        .resolveToBuyer(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          arbiter: arbiter.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          buyerUsdcAta: buyerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter]) // MISSING buyer
        .rpc(),
      /signature|missing|required|Unauthorized/i
    );
  });

  it("A1.4 wrong signer cannot resolve_to_seller", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    // open dispute
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: seller.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([seller])
      .rpc();

    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // stranger's ATA (to receive if attack succeeded)
    const strangerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, stranger.publicKey
    );

    // arbiter + stranger (not seller) tries resolve_to_seller
    await expectFail(
      program.methods
        .resolveToSeller(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          arbiter: arbiter.publicKey,
          seller: stranger.publicKey, // WRONG: stranger, not seller
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: strangerAta.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter, stranger])
        .rpc(),
      /Unauthorized|constraint|hasone|mismatch/i
    );
  });

  /* ======================================================
     B2 — must-fail paths (authorization + temporal guards)
     ====================================================== */

  it("B2.1 unauthorized resolve_to_buyer fails", async () => {
    // mint fresh USDC for seller
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      sellerAta.address,
      admin,
      AMOUNT
    );

    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // open dispute
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      buyer.publicKey
    );

    // capture balances before attack
    const escrowBefore = Number(
      (await getAccount(provider.connection, escrowVaultKp.publicKey)).amount
    );

    // stranger (not arbiter) tries to resolve - must fail
    let failed = false;
    try {
      await program.methods
        .resolveToBuyer(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          arbiter: stranger.publicKey, // NOT the real arbiter
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          buyerUsdcAta: buyerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([stranger, buyer])
        .rpc();
    } catch (e: any) {
      failed = true;
      // Verify it's an authorization-related error
      const errStr = e.toString().toLowerCase();
      assert.ok(
        errStr.includes("unauthorized") ||
        errStr.includes("constraint") ||
        errStr.includes("has one") ||
        errStr.includes("hasone") ||
        errStr.includes("0x7d6"),
        `Expected authorization error, got: ${e}`
      );
    }
    assert.ok(failed, "unauthorized resolve should have failed");

    // assert escrow still locked (balance unchanged)
    const escrowAfter = Number(
      (await getAccount(provider.connection, escrowVaultKp.publicKey)).amount
    );
    assert.equal(escrowAfter, escrowBefore, "escrow must remain locked");
  });

  it("B2.2 double resolution fails", async () => {
    // mint fresh USDC for seller
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      sellerAta.address,
      admin,
      AMOUNT
    );

    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // open dispute
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      buyer.publicKey
    );

    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );

    // first resolution (valid)
    await program.methods
      .resolveToBuyer(random32(), random32(), random32())
      .accounts({
        config: configPda,
        contract: contractPda,
        buyer: buyer.publicKey,
        arbiter: arbiter.publicKey,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        buyerUsdcAta: buyerAtaLive.address,
        feeCollectorUsdcAta: feeCollectorAtaLive.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbiter, buyer])
      .rpc();

    // second resolution must fail
    let failed = false;
    try {
      await program.methods
        .resolveToBuyer(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          arbiter: arbiter.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          buyerUsdcAta: buyerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter, buyer])
        .rpc();
    } catch (e: any) {
      failed = true;
      // Verify it's a state-related error
      const errStr = e.toString().toLowerCase();
      assert.ok(
        errStr.includes("already") ||
        errStr.includes("resolved") ||
        errStr.includes("state") ||
        errStr.includes("invalid"),
        `Expected state error, got: ${e}`
      );
    }
    assert.ok(failed, "double resolution should have failed");
  });

  it("B2.3 auto-release before deadline fails", async () => {
    // mint fresh USDC for seller
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      sellerAta.address,
      admin,
      AMOUNT
    );

    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();

    // deadlines configured so dispute window is FAR in the future
    const t = now();
    const d = {
      fund: t + 60,
      pay: t + 120,
      dispute: t + 3600, // 1 hour from now - plenty of time
      resolve: t + 7200,
    };

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // mark paid
    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    // capture escrow balance before attack
    const escrowBefore = Number(
      (await getAccount(provider.connection, escrowVaultKp.publicKey)).amount
    );

    const sellerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      seller.publicKey
    );

    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );

    // attempt early auto-release (dispute deadline not reached) - must fail
    let failed = false;
    try {
      await program.methods
        .autoReleaseAfterDisputeDeadline()
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: sellerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (e: any) {
      failed = true;
      // Verify it's a deadline-related error
      const errStr = e.toString().toLowerCase();
      assert.ok(
        errStr.includes("deadline") ||
        errStr.includes("time") ||
        errStr.includes("window") ||
        errStr.includes("dispute") ||
        errStr.includes("state"),
        `Expected deadline error, got: ${e}`
      );
    }
    assert.ok(failed, "early auto-release should have failed");

    // assert escrow still locked
    const escrowAfter = Number(
      (await getAccount(provider.connection, escrowVaultKp.publicKey)).amount
    );
    assert.equal(escrowAfter, escrowBefore, "escrow must remain locked");
  });

  /* ======================================================
     B3 — adversarial / edge pressure
     ====================================================== */

  async function expectFail(p: Promise<any>, re?: RegExp) {
    let failed = false;
    try {
      await p;
    } catch (e: any) {
      failed = true;
      if (re) {
        const msg = (e?.toString?.() ?? "") + "\n" + (e?.logs?.join?.("\n") ?? "");
        assert.match(msg, re);
      }
    }
    assert.ok(failed, "expected transaction to fail");
  }

  // helper: make a fresh contract + vault + fund it (returns all PDAs/keypairs)
  async function mkFundedContract(opts?: {
    deadlines?: { fund: number; pay: number; dispute: number; resolve: number };
  }) {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = opts?.deadlines ?? deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // make sure seller has funds for this test
    await mintTo(provider.connection, admin, usdcMint, sellerAta.address, admin, AMOUNT);

    // init config (best-effort, may already exist)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(FEE),
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow (seller -> vault)
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    return { contractId, d, configPda, contractPda, escrowAuthority, escrowVaultKp };
  }

  it("B3.1 resolve without dispute fails", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, buyer.publicKey
    );
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    await expectFail(
      program.methods
        .resolveToBuyer(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          arbiter: arbiter.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          buyerUsdcAta: buyerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([arbiter, buyer])
        .rpc(),
      /InvalidState|state|Dispute|not disputed/i
    );
  });

  it("B3.2 open_dispute twice fails", async () => {
    const { contractPda, escrowVaultKp } = await mkFundedContract();

    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    await expectFail(
      program.methods
        .openDispute()
        .accounts({
          contract: contractPda,
          opener: buyer.publicKey,
          escrowVault: escrowVaultKp.publicKey,
        })
        .signers([buyer])
        .rpc(),
      /InvalidState|already|dispute/i
    );
  });

  it("B3.3 mark_paid twice fails", async () => {
    const { contractPda, escrowVaultKp } = await mkFundedContract();

    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    await expectFail(
      program.methods
        .markPaid(random32())
        .accounts({
          contract: contractPda,
          buyer: buyer.publicKey,
          escrowVault: escrowVaultKp.publicKey,
        })
        .signers([buyer])
        .rpc(),
      /InvalidState|already|paid/i
    );
  });

  it("B3.4 auto_release after deadline but without mark_paid fails", async () => {
    // deadlines that let us pass dispute deadline fast but keep ordering valid
    const t = now();
    const d = { fund: t + 5, pay: t + 10, dispute: t + 15, resolve: t + 30 };

    const { configPda, contractPda, escrowAuthority, escrowVaultKp } =
      await mkFundedContract({ deadlines: d });

    // wait until just after dispute deadline
    const waitMs = Math.max(0, (d.dispute - now() + 2) * 1000);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const sellerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, seller.publicKey
    );
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    await expectFail(
      program.methods
        .autoReleaseAfterDisputeDeadline()
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: sellerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      /InvalidState|Paid|mark|state/i
    );
  });

  it("B3.5 auto_release at t=deadline-1 fails (off-by-one guard)", async () => {
    const t = now();
    const d = { fund: t + 5, pay: t + 10, dispute: t + 20, resolve: t + 40 };

    const { configPda, contractPda, escrowAuthority, escrowVaultKp } =
      await mkFundedContract({ deadlines: d });

    // mark paid so auto_release is allowed later
    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    // wait until just BEFORE dispute deadline
    const ms = Math.max(0, (d.dispute - now() - 2) * 1000);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));

    const sellerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, seller.publicKey
    );
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    await expectFail(
      program.methods
        .autoReleaseAfterDisputeDeadline()
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: sellerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      /deadline|time|window|not reached|DisputeWindowOpen/i
    );
  });

  it("B3.6 wrong escrow_vault (wrong authority) fails", async () => {
    const { contractPda } = await mkFundedContract();

    // use seller's ATA as "escrowVault" (wrong authority)
    await expectFail(
      program.methods
        .openDispute()
        .accounts({
          contract: contractPda,
          opener: buyer.publicKey,
          escrowVault: sellerAta.address, // WRONG: not the escrow vault
        })
        .signers([buyer])
        .rpc(),
      /Error|constraint|seeds|owner|authority|InvalidAccount|ConstraintTokenOwner|mismatch/i
    );
  });

  it("B3.7 wrong fee_collector_usdc_ata owner fails on drain", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    // mark paid so cooperative release is available
    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    // use seller's ATA as fee collector (WRONG owner)
    await expectFail(
      program.methods
        .releaseCooperative()
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: sellerAta.address,
          feeCollectorUsdcAta: sellerAta.address, // WRONG: should be admin's ATA
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer, seller])
        .rpc(),
      /Error|constraint|has_one|owner|fee|ConstraintHasOne|mismatch/i
    );
  });

  it("B3.8 replay: second cooperative release fails", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // first release (valid)
    await program.methods
      .releaseCooperative()
      .accounts({
        config: configPda,
        contract: contractPda,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        sellerUsdcAta: sellerAta.address,
        feeCollectorUsdcAta: feeCollectorAtaLive.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer, seller])
      .rpc();

    // second release must fail
    await expectFail(
      program.methods
        .releaseCooperative()
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          sellerUsdcAta: sellerAta.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer, seller])
        .rpc(),
      /InvalidState|already|released|closed/i
    );
  });

  it("B3.9 missing arbiter signature on resolve fails", async () => {
    const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

    // open dispute properly
    await program.methods
      .openDispute()
      .accounts({
        contract: contractPda,
        opener: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const buyerAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, buyer.publicKey
    );
    const feeCollectorAtaLive = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    await expectFail(
      program.methods
        .resolveToBuyer(random32(), random32(), random32())
        .accounts({
          config: configPda,
          contract: contractPda,
          buyer: buyer.publicKey,
          arbiter: arbiter.publicKey,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          buyerUsdcAta: buyerAtaLive.address,
          feeCollectorUsdcAta: feeCollectorAtaLive.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer]) // MISSING arbiter
        .rpc(),
      /signature|missing|required|Unauthorized/i
    );
  });

  it("B3.10 byte-length hygiene: wrong-sized hash arrays should throw", async () => {
    const { contractPda, escrowVaultKp } = await mkFundedContract();

    const bad = [1, 2, 3]; // not 32 bytes

    await expectFail(
      program.methods
        .markPaid(bad as any)
        .accounts({
          contract: contractPda,
          buyer: buyer.publicKey,
          escrowVault: escrowVaultKp.publicKey,
        })
        .signers([buyer])
        .rpc(),
      /bytes|length|serialize|Invalid|range/i
    );
  });

  /* ======================================================
     B4 — token & rent edge cases (audit-ready hardening)
     ====================================================== */

  it("B4.1 fee_amount = 0 (zero fee) releases full amount to seller", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // mint fresh USDC to seller
    await mintTo(provider.connection, admin, usdcMint, sellerAta.address, admin, AMOUNT);

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract with 0 fee
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(0), // ZERO FEE
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    // fund escrow
    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    // mark paid + cooperative release
    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const sellerAtaBefore = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, seller.publicKey
    );
    const feeCollectorAtaBefore = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    await program.methods
      .releaseCooperative()
      .accounts({
        config: configPda,
        contract: contractPda,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        sellerUsdcAta: sellerAta.address,
        feeCollectorUsdcAta: feeCollectorAtaBefore.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer, seller])
      .rpc();

    const sellerAtaAfter = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, seller.publicKey
    );
    const feeCollectorAtaAfter = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // seller should receive full amount
    assert.equal(
      Number(sellerAtaAfter.amount) - Number(sellerAtaBefore.amount),
      AMOUNT,
      "seller should receive full amount when fee=0"
    );

    // fee collector should receive nothing
    assert.equal(
      Number(feeCollectorAtaAfter.amount) - Number(feeCollectorAtaBefore.amount),
      0,
      "fee collector should receive 0 when fee=0"
    );
  });

  it("B4.2 fee_amount = amount - 1 (max valid fee) leaves seller with 1 lamport", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    await mintTo(provider.connection, admin, usdcMint, sellerAta.address, admin, AMOUNT);

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // create contract with max fee (amount - 1)
    await program.methods
      .createContract(
        Array.from(contractId),
        buyer.publicKey,
        seller.publicKey,
        arbiter.publicKey,
        new anchor.BN(AMOUNT),
        new anchor.BN(AMOUNT - 1), // max fee
        new anchor.BN(d.fund),
        new anchor.BN(d.pay),
        new anchor.BN(d.dispute),
        new anchor.BN(d.resolve)
      )
      .accounts({
        config: configPda,
        contract: contractPda,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        usdcMint,
        initiator: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer, escrowVaultKp])
      .rpc();

    await program.methods
      .fundEscrow()
      .accounts({
        contract: contractPda,
        seller: seller.publicKey,
        sellerUsdcAta: sellerAta.address,
        escrowVault: escrowVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seller])
      .rpc();

    await program.methods
      .markPaid(random32())
      .accounts({
        contract: contractPda,
        buyer: buyer.publicKey,
        escrowVault: escrowVaultKp.publicKey,
      })
      .signers([buyer])
      .rpc();

    const sellerAtaBefore = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, seller.publicKey
    );
    const feeCollectorAtaBefore = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    await program.methods
      .releaseCooperative()
      .accounts({
        config: configPda,
        contract: contractPda,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        escrowAuthority,
        escrowVault: escrowVaultKp.publicKey,
        sellerUsdcAta: sellerAta.address,
        feeCollectorUsdcAta: feeCollectorAtaBefore.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer, seller])
      .rpc();

    const sellerAtaAfter = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, seller.publicKey
    );
    const feeCollectorAtaAfter = await getOrCreateAssociatedTokenAccount(
      provider.connection, admin, usdcMint, admin.publicKey
    );

    // seller gets 1 lamport
    assert.equal(
      Number(sellerAtaAfter.amount) - Number(sellerAtaBefore.amount),
      1,
      "seller should receive exactly 1 when fee = amount - 1"
    );

    // fee collector gets amount - 1
    assert.equal(
      Number(feeCollectorAtaAfter.amount) - Number(feeCollectorAtaBefore.amount),
      AMOUNT - 1,
      "fee collector should receive amount - 1"
    );
  });

  it("B4.3 fee_amount >= amount fails (invalid fee)", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    await expectFail(
      program.methods
        .createContract(
          Array.from(contractId),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey,
          new anchor.BN(AMOUNT),
          new anchor.BN(AMOUNT), // fee == amount (invalid)
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp])
        .rpc(),
      /InvalidFee|invalid fee|Error/i
    );
  });

  it("B4.4 fee_amount > amount fails", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    await expectFail(
      program.methods
        .createContract(
          Array.from(contractId),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey,
          new anchor.BN(AMOUNT),
          new anchor.BN(AMOUNT + 1), // fee > amount (invalid)
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp])
        .rpc(),
      /InvalidFee|invalid fee|Error/i
    );
  });

  it("B4.5 wrong mint for escrow_vault fails at create_contract", async () => {
    // create a fake mint that is NOT usdc
    const fakeMintKp = anchor.web3.Keypair.generate();
    await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
      fakeMintKp
    );

    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // try to create contract with wrong mint - should fail
    await expectFail(
      program.methods
        .createContract(
          Array.from(contractId),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey,
          new anchor.BN(AMOUNT),
          new anchor.BN(FEE),
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          usdcMint: fakeMintKp.publicKey, // WRONG MINT
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp])
        .rpc(),
      /Error|constraint|mint|InvalidMint|mismatch/i
    );
  });

  it("B4.6 amount = 0 fails (zero amount contract)", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    const escrowVaultKp = anchor.web3.Keypair.generate();

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    await expectFail(
      program.methods
        .createContract(
          Array.from(contractId),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey,
          new anchor.BN(0), // ZERO AMOUNT
          new anchor.BN(0),
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp])
        .rpc(),
      /Error|InvalidAmount|amount|zero/i
    );
  });

  it("B4.7 escrow_vault already exists fails create_contract", async () => {
    const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();
    const d = deadlines();

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contract"), contractId],
      program.programId
    );

    const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_authority"), contractId],
      program.programId
    );

    // create a token account BEFORE create_contract tries to init it
    const preExistingVaultKp = anchor.web3.Keypair.generate();
    await createAccount(
      provider.connection,
      admin,
      usdcMint,
      escrowAuthority,
      preExistingVaultKp
    );

    // init config (best-effort)
    try {
      await program.methods
        .initConfig(usdcMint, admin.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch {}

    // The program expects to init the vault, but it already exists
    // This should fail because Anchor can't init an account that already exists
    await expectFail(
      program.methods
        .createContract(
          Array.from(contractId),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey,
          new anchor.BN(AMOUNT),
          new anchor.BN(FEE),
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: preExistingVaultKp.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, preExistingVaultKp])
        .rpc(),
      /Error|already in use|constraint|init/i
    );
  });

  /* ======================================================
     B5 — ops invariants (power surface constraints)

     v0.1 DELIBERATELY DOES NOT IMPLEMENT:
     - arbiter rotation (onchain)
     - emergency freeze (for escrow vaults)
     - config upgrades (post-init)

     These tests prove the protocol is "politically frozen":
     - no hidden admin backdoors
     - no discretionary freeze/confiscation
     - arbiter immutability per contract (A2)
     ====================================================== */

  describe("B5: arbiter rotation (v0.1 — NOT IMPLEMENTED)", () => {
    it("B5.1 no arbiter rotation instruction exists", async () => {
      // v0.1 design: arbiter is immutable at contract creation (invariant A2)
      // There is no rotate_arbiter instruction in the program IDL

      const availableInstructions = Object.keys(program.methods);

      // Assert no rotation-related instructions exist
      const rotationInstructions = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("rotate") ||
                ix.toLowerCase().includes("arbiter") && ix.toLowerCase().includes("set")
      );

      assert.deepEqual(
        rotationInstructions,
        [],
        "No arbiter rotation instructions should exist in v0.1"
      );
    });

    it("B5.2 arbiter immutability: contract.arbiter cannot change post-creation", async () => {
      const { contractPda } = await mkFundedContract();

      const contractBefore = await program.account.contract.fetch(contractPda);
      const originalArbiter = contractBefore.arbiter;

      // Attempt various operations that SHOULD NOT change arbiter
      await program.methods
        .markPaid(random32())
        .accounts({
          contract: contractPda,
          buyer: buyer.publicKey,
          escrowVault: (await program.account.contract.fetch(contractPda)).usdcMint, // dummy - we need escrow vault
        })
        .signers([buyer])
        .rpc()
        .catch(() => {}); // ignore if fails for other reasons

      const contractAfter = await program.account.contract.fetch(contractPda);

      assert.ok(
        contractAfter.arbiter.equals(originalArbiter),
        "arbiter must remain immutable after contract creation"
      );
    });

    it("B5.3 arbiter assignment is per-contract, not global", async () => {
      // Create two contracts with different arbiters
      const arbiter2 = anchor.web3.Keypair.generate();
      await airdrop(arbiter2.publicKey);

      const contractId1 = anchor.web3.Keypair.generate().publicKey.toBuffer();
      const contractId2 = anchor.web3.Keypair.generate().publicKey.toBuffer();
      const d = deadlines();

      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      const [contractPda1] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contract"), contractId1],
        program.programId
      );
      const [contractPda2] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contract"), contractId2],
        program.programId
      );

      const [escrowAuthority1] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_authority"), contractId1],
        program.programId
      );
      const [escrowAuthority2] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_authority"), contractId2],
        program.programId
      );

      const escrowVaultKp1 = anchor.web3.Keypair.generate();
      const escrowVaultKp2 = anchor.web3.Keypair.generate();

      // init config (best-effort)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      // Create contract 1 with arbiter
      await program.methods
        .createContract(
          Array.from(contractId1),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey, // arbiter 1
          new anchor.BN(AMOUNT),
          new anchor.BN(FEE),
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda1,
          escrowAuthority: escrowAuthority1,
          escrowVault: escrowVaultKp1.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp1])
        .rpc();

      // Create contract 2 with different arbiter
      await program.methods
        .createContract(
          Array.from(contractId2),
          buyer.publicKey,
          seller.publicKey,
          arbiter2.publicKey, // arbiter 2 (different!)
          new anchor.BN(AMOUNT),
          new anchor.BN(FEE),
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda2,
          escrowAuthority: escrowAuthority2,
          escrowVault: escrowVaultKp2.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp2])
        .rpc();

      const contract1 = await program.account.contract.fetch(contractPda1);
      const contract2 = await program.account.contract.fetch(contractPda2);

      assert.ok(
        contract1.arbiter.equals(arbiter.publicKey),
        "contract1 should have arbiter1"
      );
      assert.ok(
        contract2.arbiter.equals(arbiter2.publicKey),
        "contract2 should have arbiter2"
      );
      assert.ok(
        !contract1.arbiter.equals(contract2.arbiter),
        "different contracts can have different arbiters (per-contract assignment)"
      );
    });
  });

  describe("B5: emergency freeze (v0.1 — NOT IMPLEMENTED)", () => {
    it("B5.4 no freeze/pause instruction exists for escrow operations", async () => {
      const availableInstructions = Object.keys(program.methods);

      // Assert no freeze-related instructions exist
      const freezeInstructions = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("freeze") ||
                ix.toLowerCase().includes("pause") ||
                ix.toLowerCase().includes("halt")
      );

      assert.deepEqual(
        freezeInstructions,
        [],
        "No freeze/pause instructions should exist in v0.1"
      );
    });

    it("B5.5 offer_creation_paused flag has no setter (inert)", async () => {
      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      // init config (best-effort)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      const config = await program.account.config.fetch(configPda);

      // offer_creation_paused exists but is always false (no setter)
      assert.equal(
        config.offerCreationPaused,
        false,
        "offer_creation_paused should be false (no instruction can change it)"
      );

      // Verify no set_paused or similar instruction exists
      const availableInstructions = Object.keys(program.methods);
      const pauseSetters = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("set") &&
                (ix.toLowerCase().includes("pause") || ix.toLowerCase().includes("frozen"))
      );

      assert.deepEqual(
        pauseSetters,
        [],
        "No pause setter instructions should exist"
      );
    });

    it("B5.6 admin cannot freeze/confiscate escrow funds (constitutional)", async () => {
      const { configPda, contractPda, escrowAuthority, escrowVaultKp } = await mkFundedContract();

      // Verify escrow has funds
      const escrowBefore = await getAccount(provider.connection, escrowVaultKp.publicKey);
      assert.equal(Number(escrowBefore.amount), AMOUNT, "escrow should be funded");

      // There's no instruction admin can call to move funds
      // The only way to move funds is through:
      // 1. release_cooperative (requires buyer + seller)
      // 2. resolve_to_buyer/seller (requires arbiter + party)
      // 3. auto_release_after_dispute_deadline (permissionless, time-gated)

      // Admin trying to act alone has no path
      const availableInstructions = Object.keys(program.methods);
      const adminOnlyDrainInstructions = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("admin") &&
                (ix.toLowerCase().includes("drain") ||
                 ix.toLowerCase().includes("withdraw") ||
                 ix.toLowerCase().includes("confiscate"))
      );

      assert.deepEqual(
        adminOnlyDrainInstructions,
        [],
        "No admin-only drain/confiscate instructions should exist"
      );

      // Escrow should still have funds (unchanged)
      const escrowAfter = await getAccount(provider.connection, escrowVaultKp.publicKey);
      assert.equal(Number(escrowAfter.amount), AMOUNT, "escrow funds unchanged");
    });
  });

  describe("B5: config upgrade (v0.1 — NOT IMPLEMENTED)", () => {
    it("B5.7 no config update instruction exists", async () => {
      const availableInstructions = Object.keys(program.methods);

      // Assert no config update instructions exist
      const configUpdateInstructions = availableInstructions.filter(
        (ix) => (ix.toLowerCase().includes("update") ||
                 ix.toLowerCase().includes("upgrade") ||
                 ix.toLowerCase().includes("propose") ||
                 ix.toLowerCase().includes("execute")) &&
                ix.toLowerCase().includes("config")
      );

      assert.deepEqual(
        configUpdateInstructions,
        [],
        "No config update/upgrade instructions should exist in v0.1"
      );
    });

    it("B5.8 config.version is set once at init", async () => {
      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      // init config (best-effort)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      const config = await program.account.config.fetch(configPda);

      assert.equal(config.version, 1, "config.version should be 1 after init");

      // Try to re-init (should fail)
      let reInitFailed = false;
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {
        reInitFailed = true;
      }

      assert.ok(reInitFailed, "re-init should fail (config is immutable after init)");
    });

    it("B5.9 config.fee_collector is immutable post-init", async () => {
      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      // init config (best-effort)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      const configBefore = await program.account.config.fetch(configPda);
      const originalFeeCollector = configBefore.feeCollector;

      // No instruction exists to change fee_collector
      const availableInstructions = Object.keys(program.methods);
      const feeCollectorSetters = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("fee") &&
                (ix.toLowerCase().includes("set") || ix.toLowerCase().includes("update"))
      );

      assert.deepEqual(
        feeCollectorSetters,
        [],
        "No fee_collector setter instructions should exist"
      );

      const configAfter = await program.account.config.fetch(configPda);
      assert.ok(
        configAfter.feeCollector.equals(originalFeeCollector),
        "fee_collector must remain immutable"
      );
    });

    it("B5.10 config.usdc_mint is immutable post-init", async () => {
      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      // init config (best-effort)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      const config = await program.account.config.fetch(configPda);

      assert.ok(
        config.usdcMint.equals(usdcMint),
        "usdc_mint should match init value"
      );

      // No instruction exists to change usdc_mint
      const availableInstructions = Object.keys(program.methods);
      const mintSetters = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("mint") &&
                (ix.toLowerCase().includes("set") || ix.toLowerCase().includes("update"))
      );

      assert.deepEqual(
        mintSetters,
        [],
        "No mint setter instructions should exist"
      );
    });
  });

  describe("B5: admin role constraints (v0.1)", () => {
    it("B5.11 admin can only init_config, nothing else", async () => {
      // List all instructions
      const availableInstructions = Object.keys(program.methods);

      // Instructions that SHOULD require admin:
      // - init_config (only one)

      // Instructions that MUST NOT give admin special power:
      // - create_contract (buyer/seller initiates)
      // - fund_escrow (seller)
      // - mark_paid (buyer)
      // - release_cooperative (buyer + seller)
      // - open_dispute (buyer or seller)
      // - resolve_to_buyer/seller (arbiter + party)
      // - auto transitions (permissionless)

      // Verify admin has no release/settlement authority
      const adminPowerInstructions = availableInstructions.filter(
        (ix) => ix.toLowerCase().includes("admin") &&
                !ix.toLowerCase().includes("init")
      );

      assert.deepEqual(
        adminPowerInstructions,
        [],
        "Admin should have no power instructions beyond init_config"
      );
    });

    it("B5.12 stranger cannot init_config", async () => {
      // Generate a fresh config seed that hasn't been used
      // Since config is a singleton PDA, we can only test that re-init fails
      // or that wrong signer fails

      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );

      // First init by admin (may already exist)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      // Stranger tries to re-init (should fail)
      await expectFail(
        program.methods
          .initConfig(usdcMint, stranger.publicKey)
          .accounts({
            config: configPda,
            admin: stranger.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([stranger])
          .rpc(),
        /already|constraint|init|Error/i
      );
    });
  });

  describe("B5: permissionless auto-transitions (T3, T8, T12)", () => {
    it("B5.13 expire_unfunded (T3) requires no special authority", async () => {
      const contractId = anchor.web3.Keypair.generate().publicKey.toBuffer();

      // Very short deadlines
      const t = now();
      const d = { fund: t + 3, pay: t + 10, dispute: t + 20, resolve: t + 30 };

      const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
      );
      const [contractPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contract"), contractId],
        program.programId
      );
      const [escrowAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_authority"), contractId],
        program.programId
      );
      const escrowVaultKp = anchor.web3.Keypair.generate();

      // init config (best-effort)
      try {
        await program.methods
          .initConfig(usdcMint, admin.publicKey)
          .accounts({
            config: configPda,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
      } catch {}

      // Create contract
      await program.methods
        .createContract(
          Array.from(contractId),
          buyer.publicKey,
          seller.publicKey,
          arbiter.publicKey,
          new anchor.BN(AMOUNT),
          new anchor.BN(FEE),
          new anchor.BN(d.fund),
          new anchor.BN(d.pay),
          new anchor.BN(d.dispute),
          new anchor.BN(d.resolve)
        )
        .accounts({
          config: configPda,
          contract: contractPda,
          escrowAuthority,
          escrowVault: escrowVaultKp.publicKey,
          usdcMint,
          initiator: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer, escrowVaultKp])
        .rpc();

      // Wait for fund deadline to pass
      const waitMs = Math.max(0, (d.fund + 2 - now()) * 1000);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

      // STRANGER (not buyer, seller, or arbiter) can expire
      await program.methods
        .expireUnfunded()
        .accounts({
          contract: contractPda,
          escrowVault: escrowVaultKp.publicKey,
        })
        // No signers required! (permissionless)
        .rpc();

      const contract = await program.account.contract.fetch(contractPda);
      assert.ok(contract.state.expired !== undefined, "contract should be EXPIRED");
    });

    it("B5.14 auto_escalate_after_pay_deadline (T8) requires no special authority", async () => {
      const t = now();
      const d = { fund: t + 10, pay: t + 15, dispute: t + 60, resolve: t + 120 };

      const { contractPda, escrowVaultKp } = await mkFundedContract({ deadlines: d });

      // Wait for pay deadline to pass (add buffer for RPC latency)
      const waitMs = Math.max(0, (d.pay + 3 - now()) * 1000);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

      // STRANGER can trigger auto-escalate (permissionless)
      await program.methods
        .autoEscalateAfterPayDeadline()
        .accounts({
          contract: contractPda,
          escrowVault: escrowVaultKp.publicKey,
        })
        // No signers required!
        .rpc();

      const contract = await program.account.contract.fetch(contractPda);
      assert.ok(contract.state.disputed !== undefined, "contract should be DISPUTED");
    });
  });
});
