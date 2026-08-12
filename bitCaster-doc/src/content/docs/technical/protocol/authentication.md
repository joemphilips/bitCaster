---
title: "Authentication"
description: "How bitCaster authenticates requests while keeping wallet identity independent of the adapter."
sidebar:
  order: 3
---

# Authentication

The matching engine requires authentication on write endpoints. This prevents
spam and lets the service apply request ownership rules. Read-only endpoints
remain public unless their contract states otherwise.

The current adapter is [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
HTTP authentication. Nostr is an authentication adapter. It is not the generic
wallet identity, and it is not a settlement identity.

## Request body binding

For `POST`, `PUT`, and `PATCH` requests, the NIP-98 event includes a `payload`
tag. Its value is the lowercase hexadecimal SHA-256 digest of the exact request
body bytes. The engine calculates the digest from the received bytes and rejects
a mismatch.

This binding prevents a captured authentication event from authorizing a
different body during its freshness period. `GET`, `DELETE`, and requests with
no body omit the `payload` tag.

For multipart requests, calculate the digest from the exact bytes that you
send. Keep the matching `Content-Type` boundary with those bytes. The service
rejects bodies larger than 1 MiB before it calculates the digest.

## Wallet and settlement boundary

Authentication proves an authenticated request. It does not create a peer
settlement channel. A settlement request separately includes the exact
`PAY_TO_UNLOCK` capability proofs that authorize the order. Wallets use the
NUT-CTF settlement protocol for those proof operations.

## Error responses

| Status | Meaning |
| --- | --- |
| `401 Unauthorized` | The authentication token is missing, malformed, or expired. |
| `403 Forbidden` | The token is valid, but the requester cannot act on the resource. |
