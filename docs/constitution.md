# pacto/docs/constitution.md (v0.1)

## 0. purpose

pacto is a p2p marketplace for peer settlement using non-custodial escrow and human arbitration. pacto's function is judicial: it creates binding, machine-enforced settlement constraints and a dispute process. pacto is not an exchange, not a bank, and not a custodian.

v1 execution layer: solana + usdc. the constitutional principles are chain-agnostic.

## 1. core definitions

**parties**: buyer and seller.

**contract**: a single escrow agreement with fixed terms, timestamps, and state transitions.

**escrow**: a program-controlled vault holding usdc for a specific contract.

**arbiter**: a third party who can co-sign settlement in dispute paths according to rules.

**verdict**: an arbiter decision recorded as an immutable event with rationale reference.

**evidence**: artifacts submitted by parties to support claims (receipts, messages, ids).

**court**: pacto's arbitration layer (people + tooling + rules), not a state institution.

**fee**: explicit, disclosed charge for completed escrow and/or arbitration priority.

## 2. non-custody invariants (never violated)

### no unilateral seizure

pacto (or any pacto operator) must never be able to move escrowed funds unilaterally.

any settlement requires a threshold of signatures (see section 3).

### no commingling

each escrow vault is per-contract and cannot be pooled with other users' funds.

### no fiat handling

pacto never receives, holds, routes, or settles fiat.

pacto may display payment method metadata, but fiat transfer occurs off-platform between peers.

### no secret fees

all fees must be explicit, user-visible, and deterministically computable before acceptance.

### no discretionary admin backdoors

no hidden admin method may release, freeze, claw back, or redirect escrow funds.

## 3. settlement authority (threshold model)

pacto uses a 2-of-3 settlement threshold:

**keys/roles**: buyer, seller, arbiter

**normal completion**: buyer + seller

**dispute settlement**: arbiter + (buyer or seller)

pacto may operate arbiters, but the arbiter role remains constrained by the threshold model and the recorded verdict process (section 6).

## 4. contract state machine (constitutional constraints)

a contract must transition through a deterministic state machine. implementation details may vary, but the following constraints are binding:

**created**: terms locked (amount, fee, timeout schedule, parties, arbiter assignment).

**funded**: escrow vault funded with exact amount + defined fee rules.

**released**: completed by buyer + seller signature threshold.

**disputed**: entered only under defined triggers (timeout or explicit dispute action).

**resolved**: completed by arbiter + one party, with verdict recorded.

illegal transitions are not permitted. all transitions must be recorded in an append-only event log.

## 5. timeouts and liveness (no forever-lock)

pacto must prevent "funds stuck forever" outcomes.

every contract must specify:

- funding window
- payment window
- dispute window
- resolution window

entering disputed must be possible via deterministic triggers (e.g., timeouts).

if parties are inactive, escalation paths must exist so resolution is always reachable.

## 6. arbitration rules (due process constraints)

arbitration exists to resolve disputes, not to extract rents or punish users.

### minimum due process requirements:

### reasoned verdict

every verdict must include:

- winning party
- settlement action
- reference to evidence IDs
- short rationale text
- arbiter identity (pseudonymous is allowed) and timestamp

### evidence immutability

- evidence may be added, never edited in-place.
- evidence objects are content-addressed or otherwise integrity-checked.

### precedent transparency (later-phase, but binding direction)

- pacto should support precedent lookup and consistent handling per payment rail.
- arbiters should be scored for consistency and integrity.

### appeal path (future)

pacto will eventually support appeals to a higher arbiter tier; until then, arbitration assignment must be cautious and reputation-weighted.

## 7. arbiter federation (anti-corruption constraints)

pacto may begin with a small arbiter set, but must evolve toward a federated model.

**constraints:**

- arbiters must be separable from pacto operators (multiple independent arbiters allowed).
- arbiter assignment should be rotating and auditable.
- arbiters may be required to post a bond (future), with:
  - slashing only under explicit, rule-based conditions
  - an audit trail for any penalty

## 8. identity and reputation (minimal by default)

pacto is not kyc-by-default.

pacto may maintain:

- trade completion counts
- dispute rate
- age-weighted reliability
- payment-rail consistency signals

**constraints:**

- reputation must be derived from contract outcomes and recorded events.
- no "shadow bans" without explicit rules.
- visibility ranking must be explainable at a high level (e.g., "higher rep, lower disputes").

## 9. jurisdiction posture and geofencing (cordon constraints)

pacto will operate with a "global-but-geofenced" posture to reduce regulatory exposure.

**constraints:**

- pacto may restrict access by jurisdiction (ip/device/self-attestation).
- restrictions should apply at minimum to:
  - offer creation
  - contract acceptance
- pacto must maintain an internal policy registry of restricted jurisdictions and sanctions logic.
- pacto should log enforcement decisions for auditability.

## 10. observability and audit trail (integrity constraints)

pacto must maintain an append-only, tamper-evident event log for:

- contract creation
- state transitions
- signatures submitted
- disputes opened
- evidence submitted
- verdicts issued
- fee assessments

logs exist to:

- debug integrity failures
- defend arbitration decisions
- prevent internal abuse

## 11. upgrades and governance (don't rug)

upgrades are allowed only under strict conditions:

**program upgrades must be:**

- announced
- versioned
- auditable
- time-delayed where feasible

upgrades must never violate the non-custody invariants.

emergency actions (if any) must be narrowly scoped to marketplace operations (e.g., pausing new offers), not seizing escrow funds.

## 12. economic principles (fee discipline)

pacto monetizes only where it provides real value:

- **escrow toll**: small, predictable fee on completed contracts
- **priority arbitration**: paid speed/priority, not paid outcomes
- **future**: visibility boosts and desk tiers, disclosed and rule-based

pacto must not rely on:

- hidden spreads
- forced conversions
- yield games
- leverage traps

## 13. v1 scope commitment (solana-usdc)

**v1 commitments:**

- chain: solana
- asset: usdc
- features: escrow + dispute + verdict + event log + basic marketplace

**no**: multi-asset, cross-chain bridging, on-platform fiat, leverage, yield

## 14. the constitutional test

any proposed feature must pass:

1. **can pacto steal?** if yes → reject.
2. **can pacto freeze value indefinitely?** if yes → reject.
3. **does it reduce dispute clarity?** if yes → reject or redesign.
4. **does it increase surface area without increasing trust?** if yes → reject.
5. **does it preserve "court > app" posture?** if no → reject.
