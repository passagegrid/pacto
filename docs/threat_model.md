# threat model (v0.1)

what pacto protects against, what it doesn't, and why.

---

## admin attacks

### freeze / halt

**threat**: admin freezes escrow to extort users or comply with coercive demands.

**status**: impossible.

no freeze instruction exists. `offer_creation_paused` flag has no setter. admin cannot halt settlements, disputes, or fund movements.

### confiscation / redirect

**threat**: admin drains escrow vaults or redirects funds to attacker-controlled accounts.

**status**: impossible.

no admin-only drain instruction exists. all fund movements require 2-of-2 signatures (buyer+seller, arbiter+buyer, arbiter+seller) or permissionless time-gated execution.

### config manipulation

**threat**: admin changes fee_collector to steal fees, or changes usdc_mint to accept worthless tokens.

**status**: impossible.

config is set once at `init_config`. no update instruction exists. fee_collector and usdc_mint are immutable post-init.

---

## arbiter attacks

### unilateral resolution

**threat**: arbiter resolves dispute alone, stealing funds.

**status**: impossible.

`resolve_to_buyer` requires arbiter + buyer signatures.
`resolve_to_seller` requires arbiter + seller signatures.
arbiter alone cannot move funds.

### arbiter substitution

**threat**: arbiter is replaced mid-dispute with attacker-controlled key.

**status**: impossible.

arbiter is immutable per-contract (set at creation, invariant A2). no rotation instruction exists.

### collusion with one party

**threat**: arbiter colludes with buyer to steal from seller (or vice versa).

**status**: mitigated by design, not eliminated.

resolution requires consent of the receiving party. a colluding arbiter+buyer can only send funds to buyer (not to arbiter). the arbiter gains nothing directly.

residual risk: off-chain kickbacks. this is outside protocol scope.

---

## counterparty griefing

### buyer never marks paid

**threat**: buyer locks seller's collateral indefinitely by never confirming payment.

**status**: mitigated.

T8 (auto_escalate_after_pay_deadline): if buyer doesn't mark paid by `t_pay_deadline`, contract auto-escalates to DISPUTED. arbiter resolves.

### seller never confirms receipt / releases

**threat**: seller locks buyer's payment by never cooperating.

**status**: mitigated.

T12 (auto_release_after_dispute_deadline): if buyer marked paid and seller doesn't dispute, funds auto-release to seller after `t_dispute_deadline`. buyer can open dispute before deadline.

### spam disputes

**threat**: party opens frivolous disputes to waste arbiter time.

**status**: accepted risk (v0.1).

no onchain cost beyond tx fees. arbiter reputation system is off-chain (future: bonding in v0.2+).

---

## protocol-level attacks

### replay attacks

**threat**: resubmit same settlement transaction to double-drain.

**status**: impossible.

state transitions are one-way. after RELEASED/RESOLVED_*, contract state blocks re-execution. tests B2.2, B3.8 verify this.

### front-running

**threat**: attacker observes pending settlement tx and front-runs with different destination.

**status**: impossible.

destinations (seller_usdc_ata, buyer_usdc_ata) are validated against contract state. cannot substitute accounts.

### oracle manipulation

**threat**: manipulate price feeds to trigger unfair settlements.

**status**: not applicable.

v0.1 has no price oracles. escrow amount is fixed at creation in USDC.

---

## what v0.1 does NOT protect against

### off-chain coercion

if a user is physically coerced to sign a transaction, the protocol cannot help. this is outside scope.

### social engineering

if a user is tricked into signing a malicious transaction, the protocol executes it. user education is required.

### arbiter unavailability

if the assigned arbiter disappears during a dispute, funds may lock until `t_resolve_deadline`. T12 does NOT apply to DISPUTED state — only to PAID_MARKED.

**mitigation**: choose reliable arbiters. future: arbiter bonding + rotation (v0.2+).

### counterparty default on off-chain obligations

if buyer pays off-chain but seller never delivers goods, protocol can only return funds (via dispute). it cannot force delivery.

### regulatory seizure

if a government compels Circle to freeze USDC in escrow vault, the protocol cannot override this. USDC is a centralized stablecoin.

---

## trust assumptions

| component | trust assumption |
|-----------|------------------|
| solana runtime | honest supermajority of validators |
| USDC | Circle operates honestly, doesn't freeze arbitrarily |
| arbiter | chosen arbiter acts in good faith |
| counterparty | counterparty intends to complete trade (not guaranteed) |
| user | user secures their private keys |

---

## summary

| attack vector | status |
|---------------|--------|
| admin freeze | impossible |
| admin confiscation | impossible |
| config manipulation | impossible |
| arbiter unilateral | impossible |
| arbiter substitution | impossible |
| arbiter collusion | mitigated (no direct gain) |
| buyer griefing | mitigated (T8) |
| seller griefing | mitigated (T12, dispute) |
| replay | impossible |
| front-running | impossible |
| off-chain coercion | out of scope |
| arbiter unavailability | residual risk (v0.2+ fix) |
