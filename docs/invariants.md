# docs/invariants.md (v0.1)

## purpose

this document defines global, non-negotiable invariants for pacto v1.
they apply across all states, all transitions, and all implementations (program, ui, ops).

if an invariant is violated, the system is broken — even if the state machine appears correct.

these invariants are the basis for:

- onchain checks
- unit / integration tests
- arbiter reasoning
- future audits

## invariant classes

1. authority invariants
2. balance invariants
3. time & liveness invariants
4. immutability invariants
5. fee invariants
6. observability invariants
7. upgrade-safety invariants

---

## 1. authority invariants

### A1. no unilateral settlement

**statement**
no single actor (buyer, seller, arbiter, pacto operator) can move escrowed funds alone.

**formal**
any instruction that transfers funds out of escrow must satisfy:

```
signer set ∈ {
  {buyer, seller}
  {arbiter, buyer}
  {arbiter, seller}
  ∅ (permissionless auto-transitions only when explicitly defined: T3, T8, T12)
}
```

**forbidden**

- admin-only release
- arbiter-only release
- buyer-only or seller-only release (except cancellation before funding)

### A2. authority roles are fixed at creation

**statement**
buyer, seller, and arbiter identities are immutable.

**formal**
after CREATED:

- `buyer_pubkey`, `seller_pubkey`, `arbiter_pubkey` MUST NOT change.

---

## 2. balance invariants

### B1. escrow balance determinism

**statement**
escrow balance is fully determined by state.

| state | escrow balance |
|-------|----------------|
| CREATED | 0 |
| FUNDED | amount |
| PAID_MARKED | amount |
| DISPUTED | amount |
| RELEASED | 0 |
| RESOLVED_BUYER | 0 |
| RESOLVED_SELLER | 0 |
| CANCELLED | 0 |
| EXPIRED | 0 |

any deviation is a critical failure.

### B2. no partial releases

**statement**
funds may only move from escrow in one atomic settlement.

**forbidden**

- partial transfers
- staged withdrawals
- multi-step settlement

### B3. no commingling

**statement**
each escrow vault belongs to exactly one contract.

**formal**

- escrow PDA is uniquely derived from contract id
- no instruction may route funds between escrows

---

## 3. time & liveness invariants

### T1. bounded waiting (no stuck funds)

**statement**
every non-terminal state has a deterministic exit path.

**formal mapping**

| state | guaranteed exit |
|-------|-----------------|
| CREATED | T1 (fund), T2 (cancel), T3 (expire) |
| FUNDED | T4 (paid), T5 (release), T6/T7 (dispute), T8 (auto-escalate) |
| PAID_MARKED | T5 (release), T6/T7 (dispute), T12 (auto-release) |
| DISPUTED | T9/T10 (arbiter resolution) |

no state may rely solely on cooperation for exit.

### T2. deadlines are authoritative

**statement**
time windows are enforced onchain, not advisory.

**formal**

- `now > deadline` MUST disable transitions gated by that deadline.
- expired rights cannot be resurrected by signatures.

**example:**

- after `t_dispute_deadline`, PAID_MARKED → DISPUTED is forbidden.

---

## 4. immutability invariants

### I1. contract terms are frozen at creation

after CREATED, the following fields are immutable:

- buyer
- seller
- arbiter
- amount
- fee_amount / fee_formula
- all deadlines
- settlement destinations

**forbidden**

- renegotiation
- admin overrides
- "corrections"

### I2. evidence is append-only

**statement**
submitted evidence cannot be modified or deleted.

**formal**

- evidence objects are content-addressed or hash-anchored
- references may be added, never replaced

---

## 5. fee invariants

### F1. fees are charged only on success

**statement**
fees are collected only when funds leave escrow via:

- RELEASED
- RESOLVED_BUYER
- RESOLVED_SELLER
- T12 auto-release

**forbidden**

- fees on cancellation
- fees on expiry
- fees on dispute opening

### F2. fee amount is deterministic

**statement**
fee must be computable from creation data alone.

**formal**

- `fee_amount` is stored or derived from a stored formula
- no dynamic or discretionary fee changes

### F3. fees cannot exceed principal

**formal**

- `0 ≤ fee_amount < amount`

---

## 6. observability invariants

### O1. every state transition emits an event

**statement**
no silent transitions.

**formal**

each transition emits exactly one event with:

- transition type
- contract id
- timestamp
- triggering authority (if any)

### O2. verdicts are always attributable

**statement**
every arbiter resolution must be traceable.

**formal**
verdict events must include:

- arbiter pubkey
- evidence references
- rationale hash
- resolution timestamp

anonymous arbitration is allowed; unattributed arbitration is not.

---

## 7. upgrade-safety invariants

### U1. upgrades must preserve invariants

**statement**
no upgrade may weaken or remove an invariant.

**formal**

- new features may add states/transitions
- existing invariants must still hold for all old states

### U2. emergency controls are scoped

**statement**
any emergency power must NOT affect escrowed funds.

**allowed**

- pausing offer creation
- pausing new contracts

**forbidden**

- freezing escrow vaults
- forced settlement
- confiscation

---

## invariant test checklist (binding)

for each instruction in settla_escrow, tests must assert:

- [ ] authority invariant (signer set)
- [ ] balance invariant (pre/post)
- [ ] deadline invariant (now vs deadline)
- [ ] immutability invariant (fields unchanged)
- [ ] event emission invariant

if a test cannot be written for an invariant, the design is incomplete.

---

## constitutional test (restated)

any change fails if it enables:

1. unilateral fund movement
2. indefinite fund lock
3. hidden or discretionary fees
4. silent state transitions
5. post-hoc contract rewriting

---

**status**: invariants frozen for v0.1.

**next**: `programs/settla_escrow/PROGRAM_SPEC.md` (accounts + instructions, no rust yet).
