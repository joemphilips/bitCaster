---
title: "Authentication"
description: "How bitCaster authenticates trading requests to prevent spam while preserving anonymity."
sidebar:
  order: 3
---

# Authentication

The matching engine requires authentication on all write endpoints — order placement, market creation, payment requests — to prevent spam and establish order ownership. Read-only endpoints (order book snapshots, market metadata, price feeds) remain public and require no authentication. See the OpenAPI specification (`openapi.yaml`) for endpoint-level details.

The current authentication scheme is [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) HTTP Auth. Additional authentication methods are planned for the future.

## Main Key vs Ephemeral Key

When using Nostr-based authentication, it is important to understand the distinction between two types of keys.

The **main Nostr key** is the long-lived identity used for NIP-98 authentication on HTTP endpoints. The matching engine uses this public key as the user ID for order ownership and rate limiting.

The **ephemeral key** is a fresh secp256k1 keypair generated per order. The public half is sent alongside the order. After a match, the engine relays both parties' ephemeral public keys so they can establish an ECDH shared secret for encrypted atomic swap communication. The counterparty never learns your main Nostr identity — they only see the ephemeral key.

## Anonymity Considerations

Using a persistent main key means the matching engine can, in principle, track the trading history associated with that key. In practice, this is a minor concern:

1. Users can transfer traded tokens out of band — the matching engine has no control over tokens after settlement.
2. The counterparty never learns the main key; they interact only through ephemeral keys.
3. Future authentication methods like LN-auth will offer stronger anonymity by removing the need for a persistent Nostr key entirely.

## Error Responses

| Status | Meaning |
|--------|---------|
| **401 Unauthorized** | Missing, malformed, or expired authentication token |
| **403 Forbidden** | Valid token, but the authenticated user does not own the resource |
