# audit checklist

reviewer: _______________
date: _______________

instructions: for each item, verify the assertion holds by reviewing code and/or running the referenced test. mark Y (yes), N (no), or ? (unclear).

---

## A1 — no unilateral settlement

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 1 | seller alone cannot release funds | A1.1 | lib.rs:208-217 | |
| 2 | buyer alone cannot resolve dispute | A1.2 | lib.rs:344-345 | |
| 3 | arbiter alone cannot resolve dispute | A1.3 | lib.rs:344-345 | |
| 4 | wrong signer rejected on resolve_to_seller | A1.4 | lib.rs:419-420 | |
| 5 | unauthorized arbiter rejected | B2.1 | lib.rs:344 | |
| 6 | missing signature rejected | B3.9 | anchor signer constraint | |

**conclusion**: can any single actor move funds alone? Y / N

---

## A2 — authority immutability

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 7 | no arbiter rotation instruction exists | B5.1 | lib.rs (full scan) | |
| 8 | contract.arbiter immutable post-creation | B5.2 | no mutation instruction | |
| 9 | arbiter is per-contract, not global | B5.3 | lib.rs:66 | |

**conclusion**: can arbiter be changed after creation? Y / N

---

## B1 — balance determinism

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 10 | cooperative release drains escrow to 0 | B1.1 | lib.rs:237-266 | |
| 11 | resolve_to_buyer drains escrow to 0 | B1.2 | lib.rs:360-387 | |
| 12 | auto_release drains escrow to 0 | B1.3 | lib.rs:502-528 | |

**conclusion**: is escrow balance deterministic by state? Y / N

---

## B2 — no double settlement

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 13 | double resolution fails | B2.2 | lib.rs:340 (state check) | |
| 14 | second cooperative release fails | B3.8 | lib.rs:212-215 (state check) | |

**conclusion**: can funds be drained twice? Y / N

---

## B3 — temporal guards

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 15 | auto-release before deadline fails | B2.3 | lib.rs:486 | |
| 16 | off-by-one at deadline boundary fails | B3.5 | lib.rs:486 (now > deadline) | |
| 17 | T3 expire is permissionless | B5.13 | lib.rs:166-181 | |
| 18 | T8 auto-escalate is permissionless | B5.14 | lib.rs:310-328 | |
| 19 | T12 auto-release is permissionless | B1.3 | lib.rs:481-539 | |

**conclusion**: are deadlines enforced correctly? Y / N

---

## B4 — state machine integrity

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 20 | resolve without dispute fails | B3.1 | lib.rs:340 | |
| 21 | open_dispute twice fails | B3.2 | lib.rs:283-286 | |
| 22 | mark_paid twice fails | B3.3 | lib.rs:189 | |
| 23 | auto_release requires PAID_MARKED | B3.4 | lib.rs:485 | |

**conclusion**: are state transitions enforced? Y / N

---

## B5 — ops invariants (power surface absence)

### freeze

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 24 | no freeze instruction exists | B5.4 | lib.rs (full scan) | |
| 25 | offer_creation_paused has no setter | B5.5 | lib.rs (full scan) | |
| 26 | admin cannot confiscate funds | B5.6 | no admin drain instruction | |

**conclusion**: can admin freeze or confiscate? Y / N

### config

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 27 | no config update instruction exists | B5.7 | lib.rs (full scan) | |
| 28 | config.version set once at init | B5.8 | lib.rs:27 | |
| 29 | fee_collector immutable | B5.9 | no setter | |
| 30 | usdc_mint immutable | B5.10 | no setter | |

**conclusion**: can config be changed post-init? Y / N

### admin

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 31 | admin only has init_config | B5.11 | lib.rs:20-29 | |
| 32 | stranger cannot init_config | B5.12 | anchor init constraint | |

**conclusion**: does admin have excess power? Y / N

---

## account validation

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 33 | wrong escrow_vault rejected | B3.6 | anchor constraint | |
| 34 | wrong fee_collector rejected | B3.7 | lib.rs:225-229 | |
| 35 | wrong mint rejected | B4.5 | lib.rs:56 | |

---

## edge cases

| # | assertion | test | code ref | Y/N/? |
|---|-----------|------|----------|-------|
| 36 | fee=0 works | B4.1 | lib.rs:253 | |
| 37 | fee=amount-1 works | B4.2 | lib.rs:238 | |
| 38 | fee>=amount rejected | B4.3 | lib.rs:47 | |
| 39 | amount=0 rejected | B4.6 | lib.rs:46 | |
| 40 | wrong hash size rejected | B3.10 | anchor serialization | |
| 41 | pre-existing vault rejected | B4.7 | anchor init constraint | |

---

## final verdict

| question | answer |
|----------|--------|
| can any single actor move funds alone? | Y / N |
| can admin freeze, confiscate, or redirect? | Y / N |
| can arbiter be changed post-creation? | Y / N |
| are there hidden upgrade paths? | Y / N |

if all answers are **N**, the protocol is correct.

---

reviewer signature: _______________
