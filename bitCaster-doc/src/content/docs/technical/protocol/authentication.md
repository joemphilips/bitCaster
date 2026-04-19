---
title: "Authentication"
description: "How bitCaster authenticates trading requests using NIP-98 HTTP Auth with BIP-340 Schnorr signatures."
sidebar:
  order: 3
---

# Authentication

bitCaster authenticates all trade-related API requests using [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) HTTP Auth. Every write request — placing orders, creating markets, requesting payment invoices — must carry a valid NIP-98 authorization header signed with the caller's Nostr private key.

Read-only endpoints (order book snapshots, market metadata, price feeds) remain public and require no authentication.

## How NIP-98 Works

NIP-98 turns each HTTP request into a cryptographically signed statement: *"I, the owner of pubkey `X`, am making this specific request at this moment."*

The flow:

1. **Client creates a Nostr event** of kind `27235` with two tags:
   - `["u", "<absolute request URL>"]` — binds the token to this exact URL
   - `["method", "<HTTP method>"]` — binds the token to GET, POST, DELETE, etc.

2. **Client signs the event** using BIP-340 Schnorr signatures (the same scheme Nostr uses for all events). The signature proves ownership of the corresponding private key.

3. **Client sends the header:**
   ```
   Authorization: Nostr <base64url-encoded JSON of the signed event>
   ```

4. **Server validates:**
   - Event kind is `27235`
   - Timestamp is within ±60 seconds (prevents replay)
   - URL tag matches the exact request URL
   - Method tag matches the HTTP method
   - Event ID matches the NIP-01 SHA-256 hash
   - BIP-340 Schnorr signature is valid

5. **Server extracts the pubkey** from the event and uses it as the authenticated identity for the request.

## Request Signing Example

To submit an order to `POST /api/v1/deadbeef01-Alice/orders`, the client builds:

```json
{
  "id": "<SHA-256 of serialized event>",
  "pubkey": "a1b2c3d4e5f6...64 hex chars...",
  "created_at": 1713600000,
  "kind": 27235,
  "tags": [
    ["u", "https://engine.bitcaster.market/api/v1/deadbeef01-Alice/orders"],
    ["method", "POST"]
  ],
  "content": "",
  "sig": "<BIP-340 Schnorr signature...128 hex chars>"
}
```

The event is serialized to JSON, base64url-encoded, and sent as:

```
Authorization: Nostr eyJpZCI6Ii4uLiIsInB1YmtleSI6Ii4uLiIsImNyZWF0ZWR...
```

Each request requires a fresh token — tokens are not reusable because of the timestamp and URL binding.

## Endpoint Authentication Requirements

| Endpoint | Auth | Why |
|----------|------|-----|
| `POST /{marketId}/orders` | Required | Establishes order ownership |
| `DELETE /{marketId}/orders/{orderId}` | Required | Only the owner may cancel |
| `GET /{marketId}/orders/{orderId}` | Required | Only the owner may query status |
| `POST /markets/{conditionId}` | Required | Creator identity comes from auth |
| `POST /markets/{marketId}/payment-requests` | Required | Rate-limited per identity |
| TradeHub (`/hubs/trade`) | Required | Counterparty verification |
| `GET /{marketId}/orderbook` | Public | Read-only market data |
| `GET /{marketId}/liquidity` | Public | Read-only pool state |
| `GET /{marketId}/metadata` | Public | Read-only market info |
| MarketHub (`/hubs/market`) | Public | Real-time price feed |

## Two-Key Model

bitCaster uses two types of keys:

**Main Nostr key** — derived from the user's BIP-39 mnemonic. This is the long-lived identity used for NIP-98 authentication on HTTP endpoints. The matching engine uses this pubkey as the `UserId` for order ownership and rate limiting.

**Ephemeral key** — a fresh secp256k1 keypair generated per order using `secp256k1.utils.randomSecretKey()`. The public half is sent to the matching engine alongside the order. After a match, the engine relays both parties' ephemeral pubkeys so they can establish an ECDH shared secret for encrypted atomic swap communication.

The TradeHub (SignalR) uses the ephemeral key for NIP-98 authentication — the counterparty never learns your main Nostr identity. The mint only sees P2PK spends signed by ephemeral keys, so it cannot link trades to a persistent identity either.

This separation ensures that order management uses a stable identity (for cancellation, rate limiting) while trade settlement preserves unlinkability.

## Error Responses

| Status | Meaning |
|--------|---------|
| **401 Unauthorized** | Missing, malformed, or expired NIP-98 token |
| **403 Forbidden** | Valid token, but the authenticated user does not own the resource (e.g., trying to cancel another user's order) |

## Future Authentication Methods

The matching engine is designed to support additional authentication schemes beyond NIP-98. The architecture uses ASP.NET Core's native multi-scheme authentication, meaning new schemes (such as LN-auth) can be added without changing endpoint code. All schemes emit the same standard identity claim, so endpoints extract the authenticated pubkey through a single, scheme-agnostic helper.
