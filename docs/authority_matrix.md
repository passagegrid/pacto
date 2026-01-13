# authority matrix (v0.1)

## purpose

this document defines who can do what in pacto v0.1. it is the primary reference for auditors assessing operational risk and power surfaces.

**v0.1 design philosophy**: minimal power surfaces, maximal constraint. the protocol trades operational flexibility for security guarantees.

---

## roles

| role | description | onchain identity |
|------|-------------|------------------|
| **admin** | marketplace operator; can initialize config only | `config.admin` pubkey |
| **buyer** | trade counterparty purchasing goods/services | `contract.buyer` pubkey |
| **seller** | trade counterparty providing goods/services | `contract.seller` pubkey |
| **arbiter** | dispute resolver; assigned per-contract at creation | `contract.arbiter` pubkey |
| **permissionless** | any caller (no signature required) | none |

---

## settlement authority matrix

| action | instruction | required signers | quorum | state constraint | time constraint |
|--------|-------------|------------------|--------|------------------|-----------------|
| cooperative release | `release_cooperative` | buyer + seller | 2-of-2 | FUNDED or PAID_MARKED | none |
| resolve to buyer | `resolve_to_buyer` | arbiter + buyer | 2-of-2 | DISPUTED | `now <= t_resolve_deadline` |
| resolve to seller | `resolve_to_seller` | arbiter + seller | 2-of-2 | DISPUTED | `now <= t_resolve_deadline` |
| auto-release (T12) | `auto_release_after_dispute_deadline` | none (permissionless) | 0 | PAID_MARKED | `now > t_dispute_deadline` |

**invariant A1**: no single actor can move escrowed funds. every settlement path requires either:
- two signatures from distinct parties, OR
- permissionless execution gated by time + state

---

## state transition authority matrix

| transition | instruction | required signers | from state | to state | time constraint |
|------------|-------------|------------------|------------|----------|-----------------|
| T0: create | `create_contract` | buyer OR seller | (new) | CREATED | `now < t_fund_deadline` |
| T1: fund | `fund_escrow` | seller | CREATED | FUNDED | `now <= t_fund_deadline` |
| T2: cancel | `cancel_unfunded` | seller | CREATED | CANCELLED | `now <= t_fund_deadline` |
| T3: expire | `expire_unfunded` | none (permissionless) | CREATED | EXPIRED | `now > t_fund_deadline` |
| T4: mark paid | `mark_paid` | buyer | FUNDED | PAID_MARKED | `now <= t_pay_deadline` |
| T5: release | `release_cooperative` | buyer + seller | FUNDED/PAID_MARKED | RELEASED | none |
| T6/T7: dispute | `open_dispute` | buyer OR seller | FUNDED/PAID_MARKED | DISPUTED | `now <= t_dispute_deadline` |
| T8: auto-escalate | `auto_escalate_after_pay_deadline` | none (permissionless) | FUNDED | DISPUTED | `now > t_pay_deadline` |
| T9: resolve buyer | `resolve_to_buyer` | arbiter + buyer | DISPUTED | RESOLVED_BUYER | `now <= t_resolve_deadline` |
| T10: resolve seller | `resolve_to_seller` | arbiter + seller | DISPUTED | RESOLVED_SELLER | `now <= t_resolve_deadline` |
| T12: auto-release | `auto_release_after_dispute_deadline` | none (permissionless) | PAID_MARKED | RELEASED | `now > t_dispute_deadline` |

---

## admin capabilities (minimal)

| capability | instruction | who | effect | blast radius |
|------------|-------------|-----|--------|--------------|
| init config | `init_config` | deployer (becomes admin) | sets usdc_mint, fee_collector | global (once) |

**admin CANNOT**:
- move escrow funds
- freeze escrow vaults
- change contract terms post-creation
- rotate arbiters onchain
- upgrade config post-init

---

## ops invariants (power surfaces — v0.1 posture)

### arbiter rotation

| status | v0.1 |
|--------|------|
| **implemented** | NO |
| **onchain instruction** | none |
| **assignment model** | per-contract, immutable at creation (invariant A2) |
| **rotation path** | off-chain: new contracts use new arbiter |

**rationale**: avoiding governance complexity in v0.1. if an arbiter becomes unavailable, funds are protected by T12 auto-release (liveness guarantee).

### emergency freeze

| status | v0.1 |
|--------|------|
| **implemented** | NO (for escrow operations) |
| **config flag** | `offer_creation_paused` exists but has no setter |
| **escrow freeze** | constitutionally prohibited |

**rationale**: freeze mechanisms create admin backdoors. v0.1 prioritizes "no discretionary admin backdoors" (constitution.md).

**what happens if vulnerability discovered**:
1. halt new offers via marketplace (off-chain)
2. deploy program upgrade via Solana upgrade authority
3. existing contracts continue to terminal states

### config upgrade

| status | v0.1 |
|--------|------|
| **implemented** | NO |
| **onchain instruction** | none |
| **upgrade path** | program-level via Solana upgrade authority |

**rationale**: config immutability eliminates "governance attack" surface. changes require program upgrade with full re-audit.

---

## power surface summary (auditor checklist)

| power surface | v0.1 status | risk | mitigation |
|---------------|-------------|------|------------|
| arbiter rotation | NOT IMPLEMENTED | none (immutable) | per-contract assignment |
| emergency freeze | NOT IMPLEMENTED | none (no backdoor) | program upgrade only |
| config upgrade | NOT IMPLEMENTED | none (immutable) | program upgrade only |
| admin fund access | BLOCKED | none | no admin drain instruction |
| unilateral settlement | BLOCKED | none | 2-of-2 or permissionless+time |

---

## v0.2+ considerations (out of scope for v0.1)

if implemented in future versions, these would require:

### arbiter rotation
- `rotate_arbiters(new_set, new_quorum)` instruction
- governance-only signer requirement
- forward-only: existing contracts keep assigned arbiter
- `ArbiterSetRotated` event
- optional: blocked when frozen

### emergency freeze
- `set_frozen(bool, reason)` instruction
- governance-only signer
- instant freeze, timelocked unfreeze
- defined blast radius (block value-moving instructions)
- `FrozenSet` event

### config upgrade
- `propose_upgrade(params, eta)` + `execute_upgrade()` + `cancel_upgrade()`
- governance-only signer
- timelock enforced
- `ConfigUpgradeProposed/Executed/Canceled` events
- forbidden fields: escrow authority derivation, program id

---

## constitutional constraints (binding)

from `constitution.md`:

1. **no discretionary admin backdoors**: no hidden admin method may release, freeze, claw back, or redirect escrow funds
2. **upgrades must preserve invariants**: no upgrade may weaken or remove an invariant
3. **emergency controls are scoped**: any emergency power must NOT affect escrowed funds

---

## test coverage

b5 tests verify:

| test | assertion |
|------|-----------|
| B5.1 | no arbiter rotation instruction exists |
| B5.2 | arbiter immutable post-creation |
| B5.3 | arbiter assignment is per-contract |
| B5.4 | no freeze instruction exists |
| B5.5 | `offer_creation_paused` has no setter |
| B5.6 | admin cannot freeze/confiscate escrow |
| B5.7 | no config update instruction exists |
| B5.8 | `config.version` set once at init |
| B5.9 | `config.fee_collector` immutable |
| B5.10 | `config.usdc_mint` immutable |
| B5.11 | admin only has `init_config` |
| B5.12 | stranger cannot `init_config` |
| B5.13 | T3 (expire) is permissionless |
| B5.14 | T8 (auto-escalate) is permissionless |

---

**status**: authority matrix frozen for v0.1.
