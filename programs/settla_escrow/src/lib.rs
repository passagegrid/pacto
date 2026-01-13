// programs/settla_escrow/src/lib.rs
//
// pacto / settla_escrow (v0.1)
// canonical mapping to:
// - docs/state_machine.md (v0.1.1)
// - docs/invariants.md (v0.1)
// - programs/settla_escrow/PROGRAM_SPEC.md (v0.1)
//
// instructions IX0–IX11 only. no hidden admin paths.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("BCAgi5qJVDMxhEA1GJa96W3NGcqA3i9UXvfbvYwKjRzB");

#[program]
pub mod settla_escrow {
    use super::*;

    // IX0: init_config
    pub fn init_config(ctx: Context<InitConfig>, usdc_mint: Pubkey, fee_collector: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.usdc_mint = usdc_mint;
        cfg.fee_collector = fee_collector;
        cfg.offer_creation_paused = false;
        cfg.version = 1;
        Ok(())
    }

    // IX1: create_contract (T0)
    pub fn create_contract(
        ctx: Context<CreateContract>,
        contract_id: [u8; 32],
        buyer: Pubkey,
        seller: Pubkey,
        arbiter: Pubkey,
        amount: u64,
        fee_amount: u64,
        t_fund_deadline: i64,
        t_pay_deadline: i64,
        t_dispute_deadline: i64,
        t_resolve_deadline: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, PactoError::InvalidAmount);
        require!(fee_amount < amount, PactoError::InvalidFee);

        // deadline strict ordering (state_machine + PROGRAM_SPEC)
        require!(now < t_fund_deadline, PactoError::InvalidDeadlines);
        require!(t_fund_deadline < t_pay_deadline, PactoError::InvalidDeadlines);
        require!(t_pay_deadline < t_dispute_deadline, PactoError::InvalidDeadlines);
        require!(t_dispute_deadline < t_resolve_deadline, PactoError::InvalidDeadlines);

        // mint must match config
        require_keys_eq!(ctx.accounts.config.usdc_mint, ctx.accounts.usdc_mint.key(), PactoError::InvalidMint);

        // initiator is payer; must be buyer or seller (soft, but keeps intent consistent)
        let initiator = ctx.accounts.initiator.key();
        require!(initiator == buyer || initiator == seller, PactoError::Unauthorized);

        let c = &mut ctx.accounts.contract;
        c.contract_id = contract_id;
        c.buyer = buyer;
        c.seller = seller;
        c.arbiter = arbiter;
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.amount = amount;
        c.fee_amount = fee_amount;
        c.t_created = now;
        c.t_fund_deadline = t_fund_deadline;
        c.t_pay_deadline = t_pay_deadline;
        c.t_dispute_deadline = t_dispute_deadline;
        c.t_resolve_deadline = t_resolve_deadline;

        c.state = ContractState::Created;
        c.t_paid_marked = None;
        c.t_dispute_opened = None;
        c.dispute_opened_by = None;
        c.payment_ref_hash = None;

        c.verdict_id = None;
        c.rationale_hash = None;
        c.evidence_root = None;

        emit!(ContractCreated {
            contract_id,
            ts: now,
            buyer,
            seller,
            arbiter,
            amount,
            fee_amount,
            t_fund_deadline,
            t_pay_deadline,
            t_dispute_deadline,
            t_resolve_deadline,
        });

        Ok(())
    }

    // IX2: fund_escrow (T1)
    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Created, PactoError::InvalidState);
        require!(now <= c.t_fund_deadline, PactoError::DeadlinePassed);

        // seller must match
        require_keys_eq!(ctx.accounts.seller.key(), c.seller, PactoError::Unauthorized);

        // escrow must be empty pre-fund (B1)
        require!(ctx.accounts.escrow_vault.amount == 0, PactoError::EscrowBalanceMismatch);

        // mint must match
        require_keys_eq!(ctx.accounts.seller_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(ctx.accounts.escrow_vault.mint, c.usdc_mint, PactoError::InvalidMint);

        // transfer amount: seller -> escrow
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_usdc_ata.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            c.amount,
        )?;

        c.state = ContractState::Funded;

        emit!(EscrowFunded {
            contract_id: c.contract_id,
            ts: now,
            by: ctx.accounts.seller.key(),
        });

        Ok(())
    }

    // IX3: cancel_unfunded (T2)
    pub fn cancel_unfunded(ctx: Context<CancelUnfunded>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Created, PactoError::InvalidState);
        require!(now <= c.t_fund_deadline, PactoError::DeadlinePassed);
        require_keys_eq!(ctx.accounts.seller.key(), c.seller, PactoError::Unauthorized);
        require!(ctx.accounts.escrow_vault.amount == 0, PactoError::EscrowBalanceMismatch);

        c.state = ContractState::Cancelled;

        emit!(CancelledBySeller {
            contract_id: c.contract_id,
            ts: now,
        });

        Ok(())
    }

    // IX4: expire_unfunded (T3) permissionless
    pub fn expire_unfunded(ctx: Context<ExpireUnfunded>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Created, PactoError::InvalidState);
        require!(now > c.t_fund_deadline, PactoError::DeadlineNotReached);
        require!(ctx.accounts.escrow_vault.amount == 0, PactoError::EscrowBalanceMismatch);

        c.state = ContractState::Expired;

        emit!(ExpiredUnfunded {
            contract_id: c.contract_id,
            ts: now,
        });

        Ok(())
    }

    // IX5: mark_paid (T4)
    pub fn mark_paid(ctx: Context<MarkPaid>, payment_ref_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Funded, PactoError::InvalidState);
        require!(now <= c.t_pay_deadline, PactoError::DeadlinePassed);
        require_keys_eq!(ctx.accounts.buyer.key(), c.buyer, PactoError::Unauthorized);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        c.state = ContractState::PaidMarked;
        c.t_paid_marked = Some(now);
        c.payment_ref_hash = Some(payment_ref_hash);

        emit!(BuyerMarkedPaid {
            contract_id: c.contract_id,
            ts: now,
            payment_ref_hash,
        });

        Ok(())
    }

    // IX6: release_cooperative (T5) buyer+seller
    pub fn release_cooperative(ctx: Context<ReleaseCooperative>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(
            c.state == ContractState::Funded || c.state == ContractState::PaidMarked,
            PactoError::InvalidState
        );
        require_keys_eq!(ctx.accounts.buyer.key(), c.buyer, PactoError::Unauthorized);
        require_keys_eq!(ctx.accounts.seller.key(), c.seller, PactoError::Unauthorized);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        // mint checks
        require_keys_eq!(ctx.accounts.seller_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(ctx.accounts.fee_collector_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);

        // fee collector must match config
        require_keys_eq!(
            ctx.accounts.fee_collector_usdc_ata.owner,
            ctx.accounts.config.fee_collector,
            PactoError::Unauthorized
        );

        // transfers signed by escrow_authority PDA
        let bump = ctx.bumps.escrow_authority;
        let bump_slice = [bump];
        let seeds = escrow_authority_seeds(&c.contract_id, &bump_slice);
        let signer_seeds: &[&[&[u8]]] = &[&seeds];

        // amount - fee to seller
        let to_seller = c.amount.saturating_sub(c.fee_amount);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.seller_usdc_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                signer_seeds,
            ),
            to_seller,
        )?;

        // fee to fee collector
        if c.fee_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.fee_collector_usdc_ata.to_account_info(),
                        authority: ctx.accounts.escrow_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                c.fee_amount,
            )?;
        }

        c.state = ContractState::Released;

        emit!(ReleasedToSeller {
            contract_id: c.contract_id,
            ts: now,
        });

        Ok(())
    }

    // IX7: open_dispute (T6/T7)
    pub fn open_dispute(ctx: Context<OpenDispute>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(
            c.state == ContractState::Funded || c.state == ContractState::PaidMarked,
            PactoError::InvalidState
        );
        require!(now <= c.t_dispute_deadline, PactoError::DeadlinePassed);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        let opener = ctx.accounts.opener.key();
        require!(opener == c.buyer || opener == c.seller, PactoError::Unauthorized);

        // explicit block: PAID_MARKED cannot dispute after deadline (state machine v0.1.1)
        // (already covered by now <= t_dispute_deadline check)

        c.state = ContractState::Disputed;
        c.dispute_opened_by = Some(opener);
        c.t_dispute_opened = Some(now);

        emit!(DisputeOpened {
            contract_id: c.contract_id,
            ts: now,
            by: opener,
        });

        Ok(())
    }

    // IX8: auto_escalate_after_pay_deadline (T8) permissionless
    pub fn auto_escalate_after_pay_deadline(ctx: Context<AutoEscalateAfterPayDeadline>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Funded, PactoError::InvalidState);
        require!(now > c.t_pay_deadline, PactoError::DeadlineNotReached);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        c.state = ContractState::Disputed;
        c.dispute_opened_by = None;
        c.t_dispute_opened = Some(now);

        emit!(AutoEscalatedAfterPayDeadline {
            contract_id: c.contract_id,
            ts: now,
        });

        Ok(())
    }

    // IX9: resolve_to_buyer (T9) arbiter+buyer
    pub fn resolve_to_buyer(
        ctx: Context<ResolveToBuyer>,
        verdict_id: [u8; 32],
        rationale_hash: [u8; 32],
        evidence_root: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Disputed, PactoError::InvalidState);
        require!(now <= c.t_resolve_deadline, PactoError::DeadlinePassed);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        require_keys_eq!(ctx.accounts.arbiter.key(), c.arbiter, PactoError::Unauthorized);
        require_keys_eq!(ctx.accounts.buyer.key(), c.buyer, PactoError::Unauthorized);

        require_keys_eq!(ctx.accounts.buyer_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(ctx.accounts.fee_collector_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(
            ctx.accounts.fee_collector_usdc_ata.owner,
            ctx.accounts.config.fee_collector,
            PactoError::Unauthorized
        );

        let bump = ctx.bumps.escrow_authority;
        let bump_slice = [bump];
        let seeds = escrow_authority_seeds(&c.contract_id, &bump_slice);
        let signer_seeds: &[&[&[u8]]] = &[&seeds];

        let to_buyer = c.amount.saturating_sub(c.fee_amount);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.buyer_usdc_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                signer_seeds,
            ),
            to_buyer,
        )?;

        if c.fee_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.fee_collector_usdc_ata.to_account_info(),
                        authority: ctx.accounts.escrow_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                c.fee_amount,
            )?;
        }

        c.state = ContractState::ResolvedBuyer;
        c.verdict_id = Some(verdict_id);
        c.rationale_hash = Some(rationale_hash);
        c.evidence_root = Some(evidence_root);

        emit!(ResolvedToBuyer {
            contract_id: c.contract_id,
            ts: now,
            verdict_id,
            rationale_hash,
            evidence_root,
        });

        Ok(())
    }

    // IX10: resolve_to_seller (T10) arbiter+seller
    pub fn resolve_to_seller(
        ctx: Context<ResolveToSeller>,
        verdict_id: [u8; 32],
        rationale_hash: [u8; 32],
        evidence_root: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::Disputed, PactoError::InvalidState);
        require!(now <= c.t_resolve_deadline, PactoError::DeadlinePassed);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        require_keys_eq!(ctx.accounts.arbiter.key(), c.arbiter, PactoError::Unauthorized);
        require_keys_eq!(ctx.accounts.seller.key(), c.seller, PactoError::Unauthorized);

        require_keys_eq!(ctx.accounts.seller_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(ctx.accounts.fee_collector_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(
            ctx.accounts.fee_collector_usdc_ata.owner,
            ctx.accounts.config.fee_collector,
            PactoError::Unauthorized
        );

        let bump = ctx.bumps.escrow_authority;
        let bump_slice = [bump];
        let seeds = escrow_authority_seeds(&c.contract_id, &bump_slice);
        let signer_seeds: &[&[&[u8]]] = &[&seeds];

        let to_seller = c.amount.saturating_sub(c.fee_amount);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.seller_usdc_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                signer_seeds,
            ),
            to_seller,
        )?;

        if c.fee_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.fee_collector_usdc_ata.to_account_info(),
                        authority: ctx.accounts.escrow_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                c.fee_amount,
            )?;
        }

        c.state = ContractState::ResolvedSeller;
        c.verdict_id = Some(verdict_id);
        c.rationale_hash = Some(rationale_hash);
        c.evidence_root = Some(evidence_root);

        emit!(ResolvedToSeller {
            contract_id: c.contract_id,
            ts: now,
            verdict_id,
            rationale_hash,
            evidence_root,
        });

        Ok(())
    }

    // IX11: auto_release_after_dispute_deadline (T12) permissionless
    pub fn auto_release_after_dispute_deadline(ctx: Context<AutoReleaseAfterDisputeDeadline>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.contract;

        require!(c.state == ContractState::PaidMarked, PactoError::InvalidState);
        require!(now > c.t_dispute_deadline, PactoError::DeadlineNotReached);
        require!(ctx.accounts.escrow_vault.amount == c.amount, PactoError::EscrowBalanceMismatch);

        require_keys_eq!(ctx.accounts.seller_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(ctx.accounts.fee_collector_usdc_ata.mint, c.usdc_mint, PactoError::InvalidMint);
        require_keys_eq!(
            ctx.accounts.fee_collector_usdc_ata.owner,
            ctx.accounts.config.fee_collector,
            PactoError::Unauthorized
        );

        let bump = ctx.bumps.escrow_authority;
        let bump_slice = [bump];
        let seeds = escrow_authority_seeds(&c.contract_id, &bump_slice);
        let signer_seeds: &[&[&[u8]]] = &[&seeds];

        let to_seller = c.amount.saturating_sub(c.fee_amount);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.seller_usdc_ata.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                signer_seeds,
            ),
            to_seller,
        )?;

        if c.fee_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.fee_collector_usdc_ata.to_account_info(),
                        authority: ctx.accounts.escrow_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                c.fee_amount,
            )?;
        }

        c.state = ContractState::Released;

        emit!(AutoReleasedToSellerAfterDisputeDeadline {
            contract_id: c.contract_id,
            ts: now,
        });

        Ok(())
    }
}

/* ===========================
   Accounts / Contexts
   =========================== */

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(contract_id: [u8;32])]
pub struct CreateContract<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = initiator,
        space = 8 + Contract::SIZE,
        seeds = [b"contract", contract_id.as_ref()],
        bump
    )]
    pub contract: Box<Account<'info, Contract>>,

    /// CHECK: PDA authority for escrow vault. seeds enforced in constraints below.
    #[account(
        seeds = [b"escrow_authority", contract_id.as_ref()],
        bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = initiator,
        token::mint = usdc_mint,
        token::authority = escrow_authority,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub initiator: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub contract: Account<'info, Contract>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub seller_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelUnfunded<'info> {
    #[account(mut)]
    pub contract: Account<'info, Contract>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ExpireUnfunded<'info> {
    #[account(mut)]
    pub contract: Account<'info, Contract>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct MarkPaid<'info> {
    #[account(mut)]
    pub contract: Account<'info, Contract>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ReleaseCooperative<'info> {
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub contract: Account<'info, Contract>,

    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: escrow authority PDA (signs CPI)
    #[account(
        seeds = [b"escrow_authority", &contract.contract_id],
        bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_collector_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    #[account(mut)]
    pub contract: Account<'info, Contract>,
    #[account(mut)]
    pub opener: Signer<'info>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AutoEscalateAfterPayDeadline<'info> {
    #[account(mut)]
    pub contract: Account<'info, Contract>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ResolveToBuyer<'info> {
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub contract: Account<'info, Contract>,

    #[account(mut)]
    pub arbiter: Signer<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: escrow authority PDA (signs CPI)
    #[account(
        seeds = [b"escrow_authority", &contract.contract_id],
        bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub buyer_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_collector_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveToSeller<'info> {
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub contract: Account<'info, Contract>,

    #[account(mut)]
    pub arbiter: Signer<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: escrow authority PDA (signs CPI)
    #[account(
        seeds = [b"escrow_authority", &contract.contract_id],
        bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub seller_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_collector_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AutoReleaseAfterDisputeDeadline<'info> {
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub contract: Account<'info, Contract>,

    /// CHECK: escrow authority PDA (signs CPI)
    #[account(
        seeds = [b"escrow_authority", &contract.contract_id],
        bump
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub seller_usdc_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_collector_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/* ===========================
   State / Accounts
   =========================== */

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee_collector: Pubkey,
    pub offer_creation_paused: bool,
    pub version: u16,
}
impl Config {
    pub const SIZE: usize = 32 + 32 + 32 + 1 + 2;
}

#[account]
pub struct Contract {
    pub contract_id: [u8; 32],

    // immutable
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub arbiter: Pubkey,
    pub usdc_mint: Pubkey,
    pub amount: u64,
    pub fee_amount: u64,

    pub t_created: i64,
    pub t_fund_deadline: i64,
    pub t_pay_deadline: i64,
    pub t_dispute_deadline: i64,
    pub t_resolve_deadline: i64,

    // mutable
    pub state: ContractState,
    pub t_paid_marked: Option<i64>,
    pub t_dispute_opened: Option<i64>,
    pub dispute_opened_by: Option<Pubkey>,
    pub payment_ref_hash: Option<[u8; 32]>,

    // verdict metadata (set once on resolve)
    pub verdict_id: Option<[u8; 32]>,
    pub rationale_hash: Option<[u8; 32]>,
    pub evidence_root: Option<[u8; 32]>,
}
impl Contract {
    // conservative sizing (anchor Option adds 1-byte tag + payload; keep buffer)
    pub const SIZE: usize =
        32 + // contract_id
        32*4 + // buyer seller arbiter usdc_mint
        8 + 8 + // amount fee_amount
        8*5 + // timestamps
        1 + // state enum tag
        (1+8) + // t_paid_marked
        (1+8) + // t_dispute_opened
        (1+32) + // dispute_opened_by
        (1+32) + // payment_ref_hash
        (1+32) + // verdict_id
        (1+32) + // rationale_hash
        (1+32) + // evidence_root
        64; // padding for anchor serialization overhead / future minor fields
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ContractState {
    Created,
    Funded,
    PaidMarked,
    Disputed,
    Released,
    ResolvedBuyer,
    ResolvedSeller,
    Cancelled,
    Expired,
}

/* ===========================
   Events
   =========================== */

#[event]
pub struct ContractCreated {
    pub contract_id: [u8; 32],
    pub ts: i64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub arbiter: Pubkey,
    pub amount: u64,
    pub fee_amount: u64,
    pub t_fund_deadline: i64,
    pub t_pay_deadline: i64,
    pub t_dispute_deadline: i64,
    pub t_resolve_deadline: i64,
}

#[event]
pub struct EscrowFunded {
    pub contract_id: [u8; 32],
    pub ts: i64,
    pub by: Pubkey,
}

#[event]
pub struct CancelledBySeller {
    pub contract_id: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct ExpiredUnfunded {
    pub contract_id: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct BuyerMarkedPaid {
    pub contract_id: [u8; 32],
    pub ts: i64,
    pub payment_ref_hash: [u8; 32],
}

#[event]
pub struct ReleasedToSeller {
    pub contract_id: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct DisputeOpened {
    pub contract_id: [u8; 32],
    pub ts: i64,
    pub by: Pubkey,
}

#[event]
pub struct AutoEscalatedAfterPayDeadline {
    pub contract_id: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct AutoReleasedToSellerAfterDisputeDeadline {
    pub contract_id: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct ResolvedToBuyer {
    pub contract_id: [u8; 32],
    pub ts: i64,
    pub verdict_id: [u8; 32],
    pub rationale_hash: [u8; 32],
    pub evidence_root: [u8; 32],
}

#[event]
pub struct ResolvedToSeller {
    pub contract_id: [u8; 32],
    pub ts: i64,
    pub verdict_id: [u8; 32],
    pub rationale_hash: [u8; 32],
    pub evidence_root: [u8; 32],
}

/* ===========================
   Errors
   =========================== */

#[error_code]
pub enum PactoError {
    #[msg("invalid deadlines")]
    InvalidDeadlines,
    #[msg("invalid amount")]
    InvalidAmount,
    #[msg("invalid fee")]
    InvalidFee,
    #[msg("invalid mint")]
    InvalidMint,
    #[msg("invalid state")]
    InvalidState,
    #[msg("deadline passed")]
    DeadlinePassed,
    #[msg("deadline not reached")]
    DeadlineNotReached,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("escrow balance mismatch")]
    EscrowBalanceMismatch,
    #[msg("already initialized")]
    AlreadyInitialized,
}

/* ===========================
   Helpers
   =========================== */

fn escrow_authority_seeds<'a>(
    contract_id: &'a [u8; 32],
    bump: &'a [u8; 1],
) -> [&'a [u8]; 3] {
    [b"escrow_authority", contract_id.as_ref(), bump]
}
