# PROTOCOL_FREEZE.md

## v0.1 — frozen

this protocol version is constitutionally locked.

### what v0.1 does NOT have

- **no arbiter rotation** — arbiter is immutable per-contract at creation
- **no emergency freeze** — no admin can halt settlements or confiscate funds
- **no config upgrades** — config is set once at init, immutable thereafter
- **no governance** — all authority is local, explicit, consumed at creation

### what this means

any feature requiring governance, rotation, or emergency controls requires a **new program id** (v0.2+).

v0.1 stays politically dead. that is a feature.

### test status

41 tests passing. 0 skipped. 0 failing.

b1–b4: value safety, temporal guards, adversarial edges
b5: ops invariants (power surfaces proven absent)

### tag

`PACTO_V0_1_FROZEN`
