# programs/settla_escrow/PROGRAM_SPEC.md (v0.1)

## purpose

define the onchain program surface for pacto v1 escrow on solana:

- accounts (pdas, token accounts)
- instructions (mapped 1:1 to state_machine transitions)
- signer requirements (authority invariants)
- deterministic checks (deadlines, balances, immutability)
- emitted events

this spec is canonical. anchor code must match it exactly.

---

## dependencies

- spl token program (token-2022 optional later; v0.1 uses classic spl-token)
- associated token program (for destination accounts)
- system program
- clock sysvar
- rent sysvar (if needed by anchor)
- asset: usdc mint (configured per deployment; stored in config)

---

## global accounts

### 1) Config (singleton)

**pda seeds**

```
["config"]
```

**fields**

| field | type | description |
|-------|------|-------------|
| admin | Pubkey | marketplace ops only; cannot move escrow funds |
| usdc_mint | Pubkey | |
| fee_collector | Pubkey | token account owner or authority; receives fees |
| offer_creation_paused | bool | marketplace-level; not used by escrow settlement |
| version | u16 | |

**invariants**

- config cannot be used to bypass escrow signer thresholds
- admin has no power to transfer funds from escrow vaults

---

### 2) Contract (one per escrow)

**pda seeds**

```
["contract", contract_id]
```

where `contract_id` is 32 bytes (client-generated random or hash)

**fields (immutable after init)**

| field | type |
|-------|------|
| contract_id | [u8; 32] |
| buyer | Pubkey |
| seller | Pubkey |
| arbiter | Pubkey |
| usdc_mint | Pubkey (must equal config.usdc_mint) |
| amount | u64 |
| fee_amount | u64 |
| t_created | i64 |
| t_fund_deadline | i64 |
| t_pay_deadline | i64 |
| t_dispute_deadline | i64 |
| t_resolve_deadline | i64 |

**fields (mutable)**

| field | type |
|-------|------|
| state | ContractState |
| t_paid_marked | Option\<i64\> |
| t_dispute_opened | Option\<i64\> |
| dispute_opened_by | Option\<Pubkey\> |
| payment_ref_hash | Option\<[u8; 32]\> (hash of a short string/ref, optional) |

**verdict metadata (only set on resolution)**

| field | type |
|-------|------|
| verdict_id | Option\<[u8; 32]\> |
| rationale_hash | Option\<[u8; 32]\> |
| evidence_root | Option\<[u8; 32]\> (merkle root or hash of evidence list) |

**enum ContractState**

```
CREATED
FUNDED
PAID_MARKED
DISPUTED
RELEASED
RESOLVED_BUYER
RESOLVED_SELLER
CANCELLED
EXPIRED
```

---

### 3) EscrowVault (token account, program-controlled)

**pda authority**

escrow_authority pda seeds: `["escrow_authority", contract_id]`

**token account**

escrow_vault is an spl-token account:
- mint = usdc_mint
- owner = escrow_authority pda

**balance invariant**

per docs/invariants.md B1

---

## instruction set (v0.1)

each instruction emits one event.

---

### IX0: init_config

creates config.

**signers**

- admin (payer)

**checks**

- config doesn't already exist

**effects**

- set config fields

---

### IX1: create_contract (T0)

**accounts**

- config
- contract (init pda)
- escrow_authority (pda, derived)
- escrow_vault (init token account owned by escrow_authority)
- system program, token program, rent

**signers**

- initiator (buyer or seller; payer)

**args**

- contract_id: [u8;32]
- buyer: Pubkey
- seller: Pubkey
- arbiter: Pubkey
- amount: u64
- fee_amount: u64
- deadlines: t_fund_deadline, t_pay_deadline, t_dispute_deadline, t_resolve_deadline
- optional payment_ref_hash = None at creation

**checks**

- deadlines strictly increasing (as in state_machine)
- amount > 0
- 0 <= fee_amount < amount
- usdc_mint matches config
- contract pda unique

**effects**

- write immutable fields
- state = CREATED
- emit `ContractCreated`

---

### IX2: fund_escrow (T1)

**accounts**

- contract
- seller (signer)
- seller_usdc_ata
- escrow_vault
- token program
- clock sysvar

**signers**

- seller

**checks**

- contract.state == CREATED
- now <= t_fund_deadline
- escrow_vault.balance == 0
- seller_usdc_ata mint == usdc_mint
- transfer amount available

**effects**

- transfer `amount` seller → escrow_vault
- state = FUNDED
- emit `EscrowFunded`

---

### IX3: cancel_unfunded (T2)

**accounts**

- contract
- seller (signer)
- escrow_vault
- clock

**signers**

- seller

**checks**

- state == CREATED
- now <= t_fund_deadline
- escrow_vault.balance == 0

**effects**

- state = CANCELLED
- emit `CancelledBySeller`

---

### IX4: expire_unfunded (T3)

permissionless.

**accounts**

- contract
- escrow_vault
- clock

**signers**

- none

**checks**

- state == CREATED
- now > t_fund_deadline
- escrow_vault.balance == 0

**effects**

- state = EXPIRED
- emit `ExpiredUnfunded`

---

### IX5: mark_paid (T4)

**accounts**

- contract
- buyer (signer)
- escrow_vault
- clock

**signers**

- buyer

**args**

- payment_ref_hash: [u8;32] (optional; can be all zeros if none)

**checks**

- state == FUNDED
- now <= t_pay_deadline
- escrow_vault.balance == amount

**effects**

- state = PAID_MARKED
- t_paid_marked = now
- payment_ref_hash stored
- emit `BuyerMarkedPaid`

---

### IX6: release_cooperative (T5)

**accounts**

- contract
- buyer (signer)
- seller (signer)
- escrow_authority (pda)
- escrow_vault
- seller_usdc_ata (destination)
- fee_collector_usdc_ata (destination; owned by config.fee_collector or direct)
- token program
- clock (optional)

**signers**

- buyer AND seller

**checks**

- state in {FUNDED, PAID_MARKED}
- escrow_vault.balance == amount
- seller_usdc_ata mint == usdc_mint
- fee_collector_usdc_ata mint == usdc_mint

**effects**

- transfer `amount - fee_amount` escrow_vault → seller_usdc_ata (signed by escrow_authority)
- transfer `fee_amount` escrow_vault → fee_collector_usdc_ata
- state = RELEASED
- emit `ReleasedToSeller`

---

### IX7: open_dispute (T6/T7)

single instruction, caller determines opener.

**accounts**

- contract
- opener (buyer or seller) (signer)
- escrow_vault
- clock

**signers**

- opener

**checks**

- opener in {buyer, seller}
- state in {FUNDED, PAID_MARKED}
- now <= t_dispute_deadline
- escrow_vault.balance == amount
- additionally: if state == PAID_MARKED and now > t_dispute_deadline ⇒ reject (explicit)

**effects**

- state = DISPUTED
- dispute_opened_by = opener
- t_dispute_opened = now
- emit `DisputeOpened(opener)`

---

### IX8: auto_escalate_after_pay_deadline (T8)

permissionless.

**accounts**

- contract
- escrow_vault
- clock

**signers**

- none

**checks**

- state == FUNDED
- now > t_pay_deadline
- escrow_vault.balance == amount

**effects**

- state = DISPUTED
- dispute_opened_by = None
- t_dispute_opened = now
- emit `AutoEscalatedAfterPayDeadline`

---

### IX9: resolve_to_buyer (T9)

**accounts**

- contract
- arbiter (signer)
- buyer (signer)
- escrow_authority (pda)
- escrow_vault
- buyer_usdc_ata
- fee_collector_usdc_ata
- token program
- clock

**signers**

- arbiter AND buyer

**args**

- verdict_id: [u8;32]
- rationale_hash: [u8;32]
- evidence_root: [u8;32]

**checks**

- state == DISPUTED
- now <= t_resolve_deadline (v0.1 can enforce; ops still backs it up)
- escrow_vault.balance == amount

**effects**

- transfer `amount - fee_amount` → buyer_usdc_ata
- transfer `fee_amount` → fee_collector_usdc_ata
- set state = RESOLVED_BUYER
- store verdict fields on contract
- emit `ResolvedToBuyer(verdict_id)`

---

### IX10: resolve_to_seller (T10)

same as IX9 but signer set is arbiter + seller and destination is seller.

**signers**

- arbiter AND seller

**effects**

- transfer `amount - fee_amount` → seller_usdc_ata
- transfer `fee_amount` → fee_collector_usdc_ata
- set state = RESOLVED_SELLER
- store verdict fields on contract
- emit `ResolvedToSeller(verdict_id)`

---

### IX11: auto_release_after_dispute_deadline (T12)

permissionless.

**accounts**

- contract
- escrow_authority (pda)
- escrow_vault
- seller_usdc_ata
- fee_collector_usdc_ata
- token program
- clock

**signers**

- none

**checks**

- state == PAID_MARKED
- now > t_dispute_deadline
- escrow_vault.balance == amount

**effects**

- transfer `amount - fee_amount` → seller_usdc_ata
- transfer `fee_amount` → fee_collector_usdc_ata
- state = RELEASED
- emit `AutoReleasedToSellerAfterDisputeDeadline`

---

## events (anchor emit)

all events include `contract_id` and `ts`.

```
ContractCreated { buyer, seller, arbiter, amount, fee_amount, deadlines... }
EscrowFunded { by: seller }
CancelledBySeller { }
ExpiredUnfunded { }
BuyerMarkedPaid { payment_ref_hash }
ReleasedToSeller { }
DisputeOpened { by: Pubkey }
AutoEscalatedAfterPayDeadline { }
AutoReleasedToSellerAfterDisputeDeadline { }
ResolvedToBuyer { verdict_id, rationale_hash, evidence_root }
ResolvedToSeller { verdict_id, rationale_hash, evidence_root }
```

---

## error codes (minimum set)

```
InvalidDeadlines
InvalidAmount
InvalidFee
InvalidMint
InvalidState
DeadlinePassed
DeadlineNotReached
Unauthorized
EscrowBalanceMismatch
AlreadyInitialized
```

---

## security notes (v0.1)

- no onchain arbiter rotation (explicitly excluded)
- no partial release or split verdicts
- all signer thresholds enforced at instruction level
- config admin cannot move escrow funds (no instruction exists for it)

---

## next deliverables

1. write anchor code implementing IX0–IX11 exactly
2. write tests that assert each invariant per instruction
3. wire web ui to call instructions and mirror events to offchain db
