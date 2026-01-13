# audit cover note

## pacto v0.1 — settla_escrow

**program id**: `BCAgi5qJVDMxhEA1GJa96W3NGcqA3i9UXvfbvYwKjRzB`
**commit**: `a8951f34dab7275775a7ed4ef162a6ff103f5ea6`
**tag**: `PACTO_V0_1_FROZEN`
**binary sha256**: `30aa157daa7692149625e466e4be56c5d54d11065c901cf43a704e961bf3fc0f`

---

## what this is

a non-custodial escrow protocol for p2p trades. seller deposits collateral, buyer confirms off-chain payment, funds release to seller. disputes go to a per-contract arbiter.

---

## what we are asking

one question:

> **can you identify any remaining discretionary power or authority ambiguity?**

specifically:

1. can any single actor move escrowed funds alone?
2. can admin freeze, confiscate, or redirect funds?
3. can arbiter be changed after contract creation?
4. are there hidden upgrade paths or governance hooks?

if the answer to all four is "no", the protocol is correct.

---

## design stance

v0.1 has **no governance**. all authority is:
- local (per-contract)
- explicit (defined at creation)
- consumed (cannot be changed post-creation)

this is intentional. we traded operational flexibility for security guarantees.

---

## what does NOT exist (by design)

| feature | status | rationale |
|---------|--------|-----------|
| arbiter rotation | not implemented | per-contract immutability |
| emergency freeze | not implemented | no admin backdoors |
| config upgrades | not implemented | post-init immutability |
| partial releases | not implemented | atomic settlement only |
| governance | not implemented | v0.2+ scope |

---

## settlement paths (exhaustive)

| path | signers | condition |
|------|---------|-----------|
| cooperative release | buyer + seller | FUNDED or PAID_MARKED |
| resolve to buyer | arbiter + buyer | DISPUTED |
| resolve to seller | arbiter + seller | DISPUTED |
| auto-release (T12) | none (permissionless) | PAID_MARKED + past dispute deadline |

no other paths exist.

---

## files to review

| file | purpose |
|------|---------|
| `programs/settla_escrow/src/lib.rs` | program logic (995 lines) |
| `tests/settla_escrow.ts` | 41 invariant tests |
| `docs/authority_matrix.md` | who can do what |
| `docs/invariants_index.md` | invariant → test mapping |
| `docs/threat_model.md` | attack vectors |

---

## test coverage

41 tests. 0 skipped. 0 failing.

categories:
- A1: settlement authority (6 tests)
- A2: role immutability (3 tests)
- B1–B4: value safety, temporal guards, adversarial edges (25 tests)
- B5: ops invariants / power surface absence (14 tests)

---

## build & verify

```bash
anchor build
shasum -a 256 target/deploy/settla_escrow.so
# expect: 30aa157daa7692149625e466e4be56c5d54d11065c901cf43a704e961bf3fc0f

anchor test
# expect: 41 passing
```

---

## contact

[your contact info here]

---

## scope exclusions

- off-chain components (arbiter UI, marketplace)
- USDC contract (Circle's responsibility)
- solana runtime (validator consensus)

we are asking you to audit the escrow program only.
