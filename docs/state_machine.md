# docs/state_machine.md (v0.1.1)

## purpose

define the binding contract lifecycle for pacto v1 (solana + usdc), including:

- states
- transitions (who can trigger, when)
- required onchain conditions per transition
- timeouts (liveness guarantees)
- forbidden paths (hard rejects)

this document is canonical. program + ui must implement it exactly.

## entities

- **buyer**: pubkey
- **seller**: pubkey
- **arbiter**: pubkey (assigned at contract creation)
- **escrow vault**: token account controlled by program for this contract
- **fee vault**: token account controlled by program for fee collection (explicit)

## time parameters (all explicit at creation)

all timestamps are unix seconds.

- `t_created`
- `t_fund_deadline` (latest time seller may fund)
- `t_pay_deadline` (latest time buyer must mark-paid / supply reference)
- `t_dispute_deadline` (latest time to open dispute after mark-paid or after pay deadline)
- `t_resolve_deadline` (latest time to submit a verdict after dispute opened)

**notes:**

- time windows are enforced onchain via Clock sysvar.
- defaults may exist in UI, but stored values are authoritative.

## state enum

```
contract state S ∈ {
  CREATED
  FUNDED
  PAID_MARKED
  RELEASED
  CANCELLED
  DISPUTED
  RESOLVED_BUYER
  RESOLVED_SELLER
  EXPIRED
}
```

**terminal states**: RELEASED, CANCELLED, RESOLVED_BUYER, RESOLVED_SELLER, EXPIRED

## invariants (state-independent)

1. escrow vault balance is either:
   - 0 (pre-funding or post-settlement), or
   - exactly `amount` (during active funded lifecycle), or
   - exactly `amount - fee` if fee is skimmed at funding time (pick one model; see fee section)

2. funds move only by explicit instructions defined below.

3. settlement requires threshold authority:
   - normal: buyer + seller
   - dispute: arbiter + (buyer or seller)

4. no transition may modify (buyer, seller, amount, arbiter, deadlines) once CREATED.

## fee model (locked for v0.1)

to keep this deterministic and simple:

- fee is charged on successful settlement only
- fee amount `fee_amount` is fixed at creation (flat) or computed by formula stored at creation.
- settlement instruction transfers:
  - `amount - fee_amount` to winner destination
  - `fee_amount` to fee_vault

this avoids "fee on cancelled" disputes and reduces refund complexity.

---

## transitions

each transition is described as:

- **from → to**
- **who can trigger** (required signers)
- **preconditions** (onchain checks)
- **effects** (token moves, event emission)

---

### T0: create contract

**∅ → CREATED**

- **trigger**: buyer or seller (initiator signs)
- **preconditions**:
  - valid pubkeys for buyer, seller, arbiter
  - all deadlines strictly increasing:
    `t_created < t_fund_deadline < t_pay_deadline < t_dispute_deadline < t_resolve_deadline`
  - `amount > 0`
  - `fee_amount >= 0` and `fee_amount < amount`
- **effects**:
  - contract account created
  - escrow vault + fee vault addresses derived (pda)
  - emit `ContractCreated`

---

### T1: fund escrow

**CREATED → FUNDED**

- **trigger**: seller
- **required signers**: seller
- **preconditions**:
  - `now <= t_fund_deadline`
  - escrow vault balance == 0
  - seller token account has ≥ `amount`
- **effects**:
  - transfer `amount` usdc from seller → escrow vault
  - emit `EscrowFunded`

---

### T2: cancel before funding (seller)

**CREATED → CANCELLED**

- **trigger**: seller
- **required signers**: seller
- **preconditions**:
  - escrow vault balance == 0
  - `now <= t_fund_deadline`
- **effects**:
  - mark cancelled
  - emit `CancelledBySeller`

---

### T3: expire unfunded

**CREATED → EXPIRED**

- **trigger**: anyone (permissionless)
- **required signers**: none
- **preconditions**:
  - `now > t_fund_deadline`
  - escrow vault balance == 0
- **effects**:
  - mark expired
  - emit `ExpiredUnfunded`

---

### T4: buyer marks paid

**FUNDED → PAID_MARKED**

- **trigger**: buyer
- **required signers**: buyer
- **preconditions**:
  - `now <= t_pay_deadline`
  - escrow vault balance == `amount`
- **effects**:
  - store `payment_ref` (optional short string hash / bytes) and `t_paid_marked = now`
  - emit `BuyerMarkedPaid`

**note**: `payment_ref` is not a proof, just a coordination anchor.

---

### T5: cooperative release (happy path)

**FUNDED → RELEASED** or **PAID_MARKED → RELEASED**

- **trigger**: buyer + seller
- **required signers**: buyer AND seller
- **preconditions**:
  - escrow vault balance == `amount`
  - state in {FUNDED, PAID_MARKED}
  - `fee_amount < amount`
- **effects**:
  - transfer `amount - fee_amount` from escrow vault → seller destination token account
  - transfer `fee_amount` from escrow vault → fee vault (or fee collector token account)
  - set state RELEASED
  - emit `ReleasedToSeller`

---

### T6: open dispute (buyer)

**FUNDED → DISPUTED** or **PAID_MARKED → DISPUTED**

- **trigger**: buyer
- **required signers**: buyer
- **preconditions**:
  - escrow vault balance == `amount`
  - `now <= t_dispute_deadline`
  - state in {FUNDED, PAID_MARKED}
- **effects**:
  - set state DISPUTED
  - record `dispute_opened_by = buyer`, `t_dispute_opened = now`
  - emit `DisputeOpened(buyer)`

---

### T7: open dispute (seller)

**PAID_MARKED → DISPUTED** or **FUNDED → DISPUTED** (optional)

- **trigger**: seller
- **required signers**: seller
- **preconditions**:
  - escrow vault balance == `amount`
  - `now <= t_dispute_deadline`
  - state in {FUNDED, PAID_MARKED}
- **effects**:
  - set state DISPUTED
  - record `dispute_opened_by = seller`, `t_dispute_opened = now`
  - emit `DisputeOpened(seller)`

**recommendation**: allow seller to dispute even from FUNDED (e.g., buyer stalling).

---

### T8: auto-escalate on missed payment window

**FUNDED → DISPUTED**

- **trigger**: anyone (permissionless)
- **required signers**: none
- **preconditions**:
  - `now > t_pay_deadline`
  - escrow vault balance == `amount`
  - state == FUNDED
- **effects**:
  - set state DISPUTED
  - record `dispute_opened_by = null`, `t_dispute_opened = now`
  - emit `AutoEscalatedAfterPayDeadline`

this guarantees liveness: funds don't sit in FUNDED forever.

---

### T9: arbiter resolution to buyer

**DISPUTED → RESOLVED_BUYER**

- **trigger**: arbiter + buyer
- **required signers**: arbiter AND buyer
- **preconditions**:
  - escrow vault balance == `amount`
  - `now <= t_resolve_deadline`
  - state == DISPUTED
  - verdict metadata provided: `verdict_id`, `evidence_refs[]`, `rationale_hash`
- **effects**:
  - transfer `amount - fee_amount` escrow → buyer destination
  - transfer `fee_amount` escrow → fee vault
  - set state RESOLVED_BUYER
  - record verdict metadata onchain (hashes/ids)
  - emit `ResolvedToBuyer(verdict_id)`

---

### T10: arbiter resolution to seller

**DISPUTED → RESOLVED_SELLER**

- **trigger**: arbiter + seller
- **required signers**: arbiter AND seller
- **preconditions**:
  - same as T9
- **effects**:
  - transfer `amount - fee_amount` escrow → seller destination
  - transfer `fee_amount` escrow → fee vault
  - set state RESOLVED_SELLER
  - record verdict metadata
  - emit `ResolvedToSeller(verdict_id)`

---

### T12: auto-release after dispute window (paid-marked)

**PAID_MARKED → RELEASED**

- **trigger**: anyone (permissionless)
- **required signers**: none
- **preconditions**:
  - `now > t_dispute_deadline`
  - state == PAID_MARKED
  - escrow vault balance == `amount`
- **effects**:
  - transfer `amount - fee_amount` escrow → seller destination
  - transfer `fee_amount` escrow → fee vault
  - set state RELEASED
  - emit `AutoReleasedToSellerAfterDisputeDeadline`

**rationale**: buyer's PAID_MARKED is a strong commitment signal. the dispute window exists to bound uncertainty. after that window, the system must converge to a deterministic outcome without needing both signatures. therefore: auto-release to seller. this closes the only remaining "silent deadlock" path.

---

### T11: resolve deadline breach (failsafe)

**DISPUTED → (RESOLVED_BUYER|RESOLVED_SELLER)** is ideal, but what if arbiter disappears?

**v0.1 approach (simple, conservative):**

- no automatic winner selection (dangerous)
- instead: allow arbiter replacement under strict rule

#### T11a: rotate arbiter (failsafe)

**DISPUTED → DISPUTED** (arbiter changes)

- **trigger**: pacto federation (special role) OR onchain arbiter registry rule (future)
- **v0.1 recommended**: manual offchain (do not encode in program yet)

for v0.1 program: do not implement onchain arbiter swap unless you also implement a robust registry + bonding.

**so for v0.1:**

- `t_resolve_deadline` is still stored, but enforcement is informational + ops-level.
- you keep arbitration liveness by ops (multiple arbiters, monitoring, paging).

(we can tighten this in v0.2 once the arbiter registry exists.)

---

## forbidden transitions (hard rejects)

- any state → CREATED
- CREATED → PAID_MARKED
- CREATED → RELEASED
- FUNDED → CANCELLED
- PAID_MARKED → CANCELLED
- PAID_MARKED → DISPUTED when `now > t_dispute_deadline` (disputes are dead after the window)
- RELEASED → anything
- RESOLVED_* → anything
- EXPIRED → anything
- CANCELLED → anything
- any transition that changes buyer/seller/amount/arbiter/deadlines after creation
- any transition that moves funds without meeting signer threshold

---

## required events (append-only log)

each transition emits an event record (onchain log + mirrored offchain db):

- `ContractCreated`
- `EscrowFunded`
- `CancelledBySeller`
- `ExpiredUnfunded`
- `BuyerMarkedPaid`
- `ReleasedToSeller`
- `DisputeOpened`
- `AutoEscalatedAfterPayDeadline`
- `AutoReleasedToSellerAfterDisputeDeadline`
- `ResolvedToBuyer`
- `ResolvedToSeller`

**verdict events must include:**

- `verdict_id`
- `rationale_hash`
- `evidence_refs` (ids/hashes)
- `arbiter_pubkey`
- `timestamp`

---

## implementation notes (binding intent)

**v1 intentionally avoids:**

- partial releases
- split verdicts
- fee refunds
- arbiter swaps onchain
- multi-asset support

**v1 does require:**

- permissionless expiry/escalation transitions for liveness
- deterministic checks for deadlines and balances

---

## next artifacts unlocked by this doc

- **docs/invariants.md**: formalize and attach tests to each transition
- **programs/settla_escrow spec**: accounts + instructions exactly matching T0–T10
- **ops/arbitration.md**: playbooks mapping payment rails → evidence expectations → verdict rationale templates
