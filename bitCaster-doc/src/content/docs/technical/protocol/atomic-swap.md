---
title: "NUT-CTF Range Settlement"
description: "The mint-coordinated settlement model for bitCaster conditional-token orders."
sidebar:
  order: 5
---

# NUT-CTF Range Settlement

bitCaster uses NUT-CTF range settlement. It does not use a bilateral HTLC,
peer ECDH, or adaptor-signature protocol.

The first-release server accepts only public FOK orders. The GUI and CLI submit
FOK orders. Each public attempt uses one one-shot capability. FOK uses the book
state at admission. It commits the full requested quantity or cancels the
complete request. Public FAK, GTC, GTD, continuation, and residual
reauthorization are not available.

## Payment units

bitCaster accepts monetary Cashu tokens with unit `msat` only. API payment and
receipt amounts use msats. The GUI shows sats: 1,000 msats equals 1 sat.
`baseAsset: "sat"` names the asset. It is not the token unit.

A Participation Score purchase must be a positive multiple of 1,000 msats.
Each 1,000 msats buys one Score point. Receive fees do not reduce the purchased
Score. Score points and receipt amounts are separate values.

## Order authorization

A wallet authorizes one public FOK attempt with one `PAY_TO_UNLOCK` capability.
Order admission checks that capability. Admission makes no mint network call.

The authorization covers its permitted range for that attempt. Public FOK does
not rest on the book or leave a residual order. If the complete quantity cannot
fill, the engine cancels the complete request. This cancellation does not spend
the capability or trigger a refund.

## Capability API errors

Application errors from the capability API use RFC 9457
`application/problem+json`. Clients use the HTTP status and `code`.
Do not classify errors from the wording of `title` or `detail`.
Every code below starts with `settlement-capability-`.
The `type` is `/errors/` followed by the complete code.

| HTTP | Code suffix | Meaning |
| --- | --- | --- |
| 400 | `invalid-request` | Invalid request fields. |
| 400 | `invalid-artifact` | Invalid or unsupported capability artifact. |
| 400 | `policy-rejected` | Capability does not meet admission policy. |
| 402 | `score-required` | Insufficient Participation Score. |
| 404 | `not-found` | Capability or result is unavailable to this caller. |
| 409 | `conflict` | Capability identity or state conflicts. |
| 409 | `market-unavailable` | Market does not accept this capability. |
| 413 | `request-too-large` | Request exceeds a size or count limit. |
| 429 | `admission-limited` | Outstanding admission work reached a limit. |
| 429 | `capacity-exhausted` | Admission processing capacity is exhausted. |
| 503 | `admission-unavailable` | Settlement admission is temporarily unavailable. |

Capacity responses also retain `limitCode` and the diagnostic `traceId`.
Missing results and results owned by another user have the same 404 response.
Authentication, framework input validation, request-size limits, and rate limits
can return a different body shape.

These are API request errors, not settlement-group states. An error alone does
not authorize a refund or deletion of local records. Keep the original operation
and capability when the response is uncertain. Retry the original request
without changes.

## Order submission errors

Single-order submission also returns application Problem Details. The `type`
is `/errors/` followed by the `code`. Use the code, not the message wording.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `order-invalid-request` | Order request fields are invalid. |
| 400 | `order-invalid-comment` | The attached comment is invalid. |
| 403 | `market-closed` | The market is closed before submission. |
| 404 | `order-market-not-found` | The market is not registered. |
| 404 | `order-capability-not-found` | The capability is unavailable to this caller. |
| 409 | `order-capability-route-mismatch` | The route differs from the bound order. |
| 409 | `order-capability-not-current` | The capability is not current for this order. |
| 409 | `order-book-conflict` | Retry the original request without changes. |
| 409 | `order-processing-conflict` | Submission conflicts with the current order state. |
| 409 | `order-market-closed` | The market closed during submission. |
| 503 | `order-admission-unavailable` | Order admission is temporarily unavailable. |
| 503 | `order-processing-unavailable` | Order processing is temporarily unavailable. |

Only `order-book-conflict` is the retryable application `409`. Do not apply
that rule to every conflict. The SDK retains the original operation for `403`
and `503` responses. An error does not prove that a refund is complete or
authorize deletion of wallet records. An exact accepted replay returns the
prior admission result. Missing and foreign capabilities have the same response.
The shared closed-market check also returns `market-closed` for deposits.
Framework errors can use another body shape.

## Batch, cancellation, and read errors

These order endpoints use the same application Problem Details format.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `order-invalid-request` | The route, condition, or batch request is invalid. |
| 403 | `market-closed` | The market is closed before batch submission. |
| 404 | `order-market-not-found` | The market for a batch request is not registered. |
| 404 | `order-not-found` | The order is unavailable for this request. |
| 409 | `order-batch-conflict` | The order book changed during batch submission. |
| 409 | `order-market-closed` | The market closed during batch submission. |
| 409 | `order-cancellation-conflict` | Order state changed during cancellation. |
| 429 | `order-batch-limited` | The application batch rate limit was reached. |

A whole-request batch error does not prove that no item was accepted.
Reconcile the original item identities before retrying without changes.
Successful batch responses retain their separate per-item results.
Do not use the single-order submission error classifier for a batch.

Cancellation returns the same `404` for missing, foreign, and wrong-route
orders. An already-terminal cancellation succeeds. Batch cancellation remains
available after market closure. A notification lookup failure after a committed
batch cancellation does not change its successful result.

Order-status reads return `404` for an absent or wrong-route order, and `403`
for a found order owned by another user. The latter is an authorization response,
not a `market-closed` error. The SDK returns `null` for a status-read `404` and
`false` for a cancellation `404`. With no registered market, order-list and
order-book reads still return successful empty data. This is distinct from a
failed read. Framework errors can use another body shape.

## Market-funding delivery errors

`POST /api/v1/cashu-deliveries/{deliveryId}` submits an exact delivery.
`GET` on the same path reads its saved status. A failed request does not prove
that no funds were received. Keep the original delivery ID, token, and immutable
request for recovery. Do not create a replacement payment for an uncertain result.

The following application errors use `application/problem+json`. Their `type`
is `/errors/{code}`. Use the HTTP status and `code`, not the wording of `detail`.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `cashu-delivery-invalid-request` | Invalid delivery identity or metadata. |
| 403 | `cashu-delivery-forbidden` | The authenticated subject cannot access this delivery. |
| 409 | `cashu-delivery-conflict` | The request conflicts with saved state, or the delivery was rejected. |
| 400 | `market-funding-invalid-request` | Invalid funding amount, unit, or product binding. |
| 404 | `market-funding-market-not-found` | The funding market was not found. |
| 403 | `market-closed` | The market is closed to new funding. |
| 500 | `cashu-delivery-state-unavailable` | The delivery state could not be read after admission. |
| 502 | `cashu-delivery-recipient-unavailable` | The recipient is unavailable. |
| 502 | `cashu-delivery-invalid-receipt` | The recipient receipt could not be verified. |
| 404 | `cashu-delivery-not-found` | The status handler could not find the delivery. |

Market closure does not itself invalidate an exact retry of a saved delivery. Successful
responses retain the saved delivery status. A rejected status read returns `409`.
A missing status returns `404`; another subject's status returns `403`.
Route constraints, framework validation, authentication, rate limits, and
Score-specific failures can use other error bodies. These codes do not apply
to every response with the same HTTP status.

The SDK delivery methods discard error bodies because a recipient can echo a
bearer token. They report status-only errors and do not retry automatically.
The status method returns `null` for `404`. This SDK behavior is separate from
the API's structured error format.

## Matching and grouping

The engine creates a fill for each matched quantity. `fillId` identifies one
real fill.

The engine groups one or more fills for atomic settlement. `groupId` identifies
one atomic settlement group. A group is not a substitute for a fill, and a fill
is not a substitute for a group.

The engine can coalesce compatible fills until the bounded group deadline. It
freezes the group before it submits the conversion.

The engine submits one multi-party conversion to the mint for the group. The
current product supports complementary and mint conversion. The mint decides
the result of that conversion. The NUT defines merge conversion, but bitCaster
does not expose it in this release.

## Confirmation and recovery

The API and settlement notifications use `ExpiredBeforeSubmission` when
authorization expires before submission. `RejectedBeforeSubmission` means
the group stopped before committing a mint request for another reason.
Both have a null `frozenAt`. Neither confirms wallet recovery or authorizes
a refund. Clients read the authoritative order status and keep their recovery
records if that read fails. Only `Confirmed` signals confirmed-result recovery.

On confirmation, the mint returns exact result entries for the group. Clients
persist the submitted operation and its result. This lets a client recover the
exact operation and result after a crash.

Submission can be absent or uncertain after a client or network failure. In
that case, the client reconciles with the durable engine and mint authority.
It must not infer success from a local request alone. A `PAY_TO_UNLOCK`
capability remains refundable after expiry as defined by the NUT.

An acknowledged FOK operation stores its operation facts and result. These
records survive a server restart. An intentional reuse of the same client order
ID with the same operation facts returns the stored result.
Changed facts return a conflict.

## Trust boundary

The wallet sends the exact `PAY_TO_UNLOCK` input proofs that authorize an
order. The engine therefore sees those proofs and their secrets. It also sees
the public blinded-output manifest. It does not receive the wallet seed, output
blinding factors, refund key, or other wallet proofs.

The engine can select only outputs that the wallet authorized. It cannot
unblind an output, redirect value outside the manifest, spend another wallet
proof, or extend the lock past its expiry. If the engine withholds settlement,
the authorized proofs remain unavailable until their refund path becomes
valid.

The mint performs the conversion and returns the confirmed result entries.
Wallets keep the material that controls proofs and blinding. Nostr
authentication identifies an authenticated request through the current adapter.
It is not a settlement key exchange and it is not the generic wallet identity.

## Scope

This product supports sat-denominated assets. It does not provide USD assets.
Cashu can provide other features, including HTLC or P2PK conditions, but
bitCaster does not use them for its current settlement model.
