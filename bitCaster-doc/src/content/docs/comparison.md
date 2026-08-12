---
title: Comparison to Similar Platforms
---

# Comparison to similar platforms

## Predyx

[Predyx](https://beta.predyx.com/) uses a server-side custody model and an AMM.
bitCaster uses a CLOB and Cashu bearer tokens.

bitCaster wallets control their general proof inventory. For an order, the
wallet gives the engine only the exact `PAY_TO_UNLOCK` capability. The engine
cannot redirect that value, extend its expiry, or spend other wallet proofs.
The mint still holds the Bitcoin reserves behind issued ecash, so users must
trust the mint operator.

## Polymarket

[Polymarket](https://polymarket.com) settles CTF trades on Polygon. bitCaster
uses sat-denominated Cashu ecash and a mint conversion for each atomic
settlement group.

Both systems use complementary and mint conversion concepts. Polymarket also
supports merge conversion. bitCaster does not expose merge conversion in this
release. bitCaster groups one or more fills and submits one multi-party mint
conversion. The mint returns exact result entries when it confirms the group.

bitCaster does not require a public blockchain transaction, gas token, or
bridge. Its ecash model improves transaction privacy, but it does not give the
public audit trail of an on-chain transaction.

## Summary

bitCaster uses Cashu bearer tokens, a CLOB, and mint-coordinated NUT-CTF range
settlement. It does not use a bilateral peer swap. The current product asset is
sat.
