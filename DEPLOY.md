# DEPLOY.md

reproducibility guide for pacto v0.1.

---

## versions

| component | version |
|-----------|---------|
| solana-cli | 3.1.6 |
| anchor-cli | 0.32.1 |
| rustc | 1.87.0 |
| anchor-lang | 0.30.1 |

---

## program id

```
BCAgi5qJVDMxhEA1GJa96W3NGcqA3i9UXvfbvYwKjRzB
```

---

## frozen commit

```
tag: PACTO_V0_1_FROZEN
hash: a8951f34dab7275775a7ed4ef162a6ff103f5ea6
```

---

## binary hash

```
sha256: 30aa157daa7692149625e466e4be56c5d54d11065c901cf43a704e961bf3fc0f
file: target/deploy/settla_escrow.so
```

---

## build

```bash
anchor build
```

verify hash:
```bash
shasum -a 256 target/deploy/settla_escrow.so
```

---

## test

```bash
anchor test
```

expected: 41 passing, 0 failing.

---

## config init params

```typescript
init_config(
  usdc_mint: <USDC_MINT_PUBKEY>,
  fee_collector: <FEE_COLLECTOR_PUBKEY>
)
```

config PDA: `seeds = ["config"]`

---

## deploy (devnet)

```bash
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

---

## deploy (mainnet)

```bash
solana config set --url mainnet-beta
anchor deploy --provider.cluster mainnet
```

**warning**: mainnet deployment is irreversible. ensure audit is complete.

---

## verify deployment

```bash
solana program show <PROGRAM_ID>
```

compare deployed binary hash with local build.
