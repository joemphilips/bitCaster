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

The **ephemeral key** is a fresh secp256k1 keypair generated per order. The public half is sent alongside the order as a 33-byte compressed point — an `02` or `03` prefix byte followed by 64 lowercase hex characters of the X coordinate. This is the same encoding `secp256k1.getPublicKey(privkey, true)` produces, and it is intentionally distinct from the main Nostr key, which uses the 32-byte x-only encoding from BIP-340. The matching engine validates the compressed shape on submission, so passing an x-only pubkey by mistake yields a `400`. After a match, the engine relays both parties' ephemeral public keys so they can establish an ECDH shared secret for encrypted atomic swap communication. The counterparty never learns your main Nostr identity — they only see the ephemeral key.

## Request Body Binding

For body-bearing methods (`POST`, `PUT`, `PATCH`), the NIP-98 event must include a `payload` tag whose value is the lowercase-hex SHA-256 of the request body bytes. The matching engine recomputes the digest from the bytes it actually receives and rejects the request when the value disagrees. Without this binding, a captured token could be replayed within its 60-second freshness window against the same URL and method but with a tampered body, placing an order the user never signed.

For multipart bodies, hash the exact bytes that will be transmitted, including the multipart boundary the client generates. The most reliable way is to pre-serialize the body via a transient `Request` object, take its `arrayBuffer()`, hash that, and then ship the same bytes with the same `Content-Type` header — letting `fetch` choose its own boundary at send time would produce a hash that no longer matches what the server receives.

`GET`, `DELETE`, and SignalR negotiate calls have no body and omit the `payload` tag. Bodies larger than 1 MiB are rejected before the digest is computed, so clients should bound user-controlled inputs (notably market thumbnails) below that limit.

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
