# invariants index (v0.1)

maps each invariant to its test coverage.

---

## A — authority invariants

### A1: no unilateral settlement

no single actor can move escrowed funds alone.

| test | assertion |
|------|-----------|
| A1.1 | seller alone cannot cooperative release |
| A1.2 | buyer alone cannot resolve dispute |
| A1.3 | arbiter alone cannot resolve dispute |
| A1.4 | wrong signer cannot resolve_to_seller |
| B2.1 | unauthorized resolve_to_buyer fails |
| B3.9 | missing arbiter signature on resolve fails |

### A2: authority roles fixed at creation

buyer, seller, arbiter immutable after contract creation.

| test | assertion |
|------|-----------|
| B5.1 | no arbiter rotation instruction exists |
| B5.2 | arbiter immutable post-creation |
| B5.3 | arbiter assignment is per-contract |

---

## B1 — balance invariants

### B1: escrow balance determinism

escrow balance is fully determined by state.

| test | assertion |
|------|-----------|
| B1.1 | cooperative release drains escrow (RELEASED → 0) |
| B1.2 | dispute resolution drains escrow (RESOLVED_BUYER → 0) |
| B1.3 | T12 auto-release drains escrow (RELEASED → 0) |

### B2: no partial releases

| test | assertion |
|------|-----------|
| B2.2 | double resolution fails |
| B3.8 | replay: second cooperative release fails |

---

## B2 — temporal guards

### T1: bounded waiting (no stuck funds)

| test | assertion |
|------|-----------|
| B5.13 | T3 (expire_unfunded) is permissionless |
| B5.14 | T8 (auto_escalate) is permissionless |
| B1.3 | T12 (auto_release) is permissionless |

### T2: deadlines are authoritative

| test | assertion |
|------|-----------|
| B2.3 | auto-release before deadline fails |
| B3.5 | auto_release at t=deadline-1 fails (off-by-one) |

---

## B3 — adversarial edges

### state machine integrity

| test | assertion |
|------|-----------|
| B3.1 | resolve without dispute fails |
| B3.2 | open_dispute twice fails |
| B3.3 | mark_paid twice fails |
| B3.4 | auto_release without mark_paid fails |

### account validation

| test | assertion |
|------|-----------|
| B3.6 | wrong escrow_vault fails |
| B3.7 | wrong fee_collector owner fails |
| B3.10 | wrong-sized hash arrays throw |

---

## B4 — fee & token edge cases

| test | assertion |
|------|-----------|
| B4.1 | fee=0 releases full amount |
| B4.2 | fee=amount-1 leaves seller with 1 |
| B4.3 | fee >= amount fails |
| B4.4 | fee > amount fails |
| B4.5 | wrong mint fails |
| B4.6 | amount=0 fails |
| B4.7 | pre-existing vault fails |

---

## B5 — ops invariants (power surface absence)

### arbiter rotation

| test | assertion |
|------|-----------|
| B5.1 | no rotation instruction exists |
| B5.2 | arbiter immutable post-creation |
| B5.3 | per-contract assignment (not global) |

### emergency freeze

| test | assertion |
|------|-----------|
| B5.4 | no freeze instruction exists |
| B5.5 | offer_creation_paused has no setter |
| B5.6 | admin cannot freeze/confiscate |

### config upgrade

| test | assertion |
|------|-----------|
| B5.7 | no config update instruction exists |
| B5.8 | config.version set once at init |
| B5.9 | fee_collector immutable |
| B5.10 | usdc_mint immutable |

### admin constraints

| test | assertion |
|------|-----------|
| B5.11 | admin only has init_config |
| B5.12 | stranger cannot init_config |

---

## test summary

| category | tests | status |
|----------|-------|--------|
| A1 (settlement authority) | 6 | ✔ |
| A2 (role immutability) | 3 | ✔ |
| B1 (balance) | 3 | ✔ |
| B2 (temporal) | 5 | ✔ |
| B3 (adversarial) | 10 | ✔ |
| B4 (fees/tokens) | 7 | ✔ |
| B5 (ops) | 14 | ✔ |
| **total** | **41** | **✔** |
