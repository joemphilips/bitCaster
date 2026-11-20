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

## Conditional outcome collections

Mint outcome collections use the outcome order in the registered oracle
announcement. Do not sort the labels to form a mint request. For example, with
announcement order `Alpha, Beta, Gamma, Delta`, the complement of `Alpha` is
`Beta|Gamma|Delta`.

Validate the public announcement signatures and the condition registration
before selecting conditional keysets. Match each keyset to the exact wire
collection and its collection ID. A valid oracle signature authenticates the
announcement contents. It does not, by itself, prove which announcements or
threshold the mint registered. Use the configured mint's registration and any
existing registered authority for that check.

Keep existing proofs, keyset IDs, and saved signed requests unchanged. Retry an
unfinished operation with its original request bytes.

## Order authorization

A wallet authorizes one public FOK attempt with one `PAY_TO_UNLOCK` capability.
Order admission checks that capability. Admission makes no mint network call.

The wallet sends the capability in the order request itself:
`POST /api/v1/{marketId}/orders` with `settlementCapabilityAdmission`. That
value holds the capability artifact and the order intent, and its `marketId`
equals the route. One request binds the capability and accepts the order, or
the engine writes nothing. A refusal is not charged. The response holds
`settlementCapability`, the capability of the accepted order.

The authorization covers its permitted range for that attempt. Public FOK does
not rest on the book or leave a residual order. If the complete quantity cannot
fill, the engine cancels the complete request. This cancellation does not spend
the capability or trigger a refund.

### Removed two-step route

The engine does not accept the older two-step route. That route sent
`POST /api/v1/settlement-capabilities` and then an order request with the
`settlementCapability` reference. Each request below gets `410` with its
`code`. The engine writes nothing and charges nothing.

| Request | Code |
| --- | --- |
| `POST /api/v1/settlement-capabilities` | `settlement-capability-stage-route-removed` |
| `POST /api/v1/{marketId}/orders` with only `settlementCapability` | `order-reference-form-removed` |
| `POST /api/v1/conditions/{conditionId}/orders/batch` | `order-reference-form-removed` |

The batch route took only the `settlementCapability` reference, so it is
removed too. The read routes of a capability and of its result stay. A
`stageIdempotencyKey` that the two-step route used conflicts on the order
request.

A client that uses the two-step route cannot place orders. This includes the
CLI releases `cli-v0.1.0-afaa6cc6aa6b` and `cli-v0.1.0-4fe7f6e6c08f`, and a
browser tab that still runs an app of the same period. These clients also
refuse a fill with the path `Merge`, so they cannot read an order that has a
merge fill. Download the latest CLI release, or reload the browser app. The
current wallet reads the order records that an older client left in the same
wallet profile. It sends no request that can create their orders. It refunds
their locked funds after the authorization expires.

## Capability API errors

The capability read routes, the order request, and the removed stage route
return these errors. Application errors use RFC 9457
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
| 410 | `stage-route-removed` | The removed stage route. Nothing is written. |
| 413 | `request-too-large` | Request exceeds a size or count limit. |
| 429 | `admission-limited` | Outstanding admission work reached a limit. |
| 429 | `capacity-exhausted` | A capability limit for this user, this market, or the service is reached. |
| 503 | `admission-unavailable` | Settlement admission is temporarily unavailable. |

Capacity responses also retain `limitCode` and the diagnostic `traceId`.
The `limitCode` names the scope and the limit, for example `owner-active-count`.
Missing results and results owned by another user have the same 404 response.
Authentication, framework input validation, request-size limits, and rate limits
can return a different body shape.

These are API request errors, not settlement-group states. An error alone does
not authorize a refund or deletion of local records. Keep the original operation
and capability when the response is uncertain. Retry the original request
without changes.

A capability read does not mean that wallet recovery is complete. If no order
was accepted, keep recovery active until the authorization reaches a terminal
result. An unspent authorization can refund after its original expiry, once the
mint confirms the required recovery facts.

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
| 410 | `order-reference-form-removed` | The body holds only the removed `settlementCapability` reference. |
| 503 | `order-admission-unavailable` | Order admission is temporarily unavailable. |
| 503 | `order-processing-unavailable` | Order processing is temporarily unavailable. |
| 503 | `order-quotes-refreshing` | Quotes are not ready. The order was refused before acceptance. |

The order request can also return the `settlement-capability-` codes of the
capability API, for example `402` `settlement-capability-score-required` or
`409` `settlement-capability-conflict`. A body above 400,000 bytes gets `413`
before authentication. The `order-submit` rate limit and the admission limits
return `429`.

The clients use one outcome for each response:

- A documented refusal writes nothing: `400`, `402`, `404`
  `order-market-not-found` and `settlement-capability-not-found`, `409`
  `order-processing-conflict`, `order-market-closed`,
  `settlement-capability-conflict` and `settlement-capability-market-unavailable`,
  `413` and `429`. The wallet records the refusal. The reserved funds return
  through the refund after the authorization expires.
- `403` `market-closed`, `404` `order-capability-not-found` and `409`
  `order-capability-route-mismatch` or `order-capability-not-current` can also
  answer a repeated request whose order already exists. The client treats them
  as uncertain.
- `order-quotes-refreshing` and `order-book-conflict` refuse before acceptance
  and commit nothing. Only while you wait in the submit flow, the client sends
  the identical request again within the limits in
  [Waiting for fresh quotes](/technical/architecture/trading-model/#waiting-for-fresh-quotes).
  If the wait stops and every attempt got one of these refusals, the client
  records a refusal.
- Every other response is uncertain, for example a timeout,
  `order-admission-unavailable`, `order-processing-unavailable` or a generic
  `503`. The client never sends the order again. It reads the order through the
  order lookup below.

Do not apply the resend rule to every conflict. `order-quotes-refreshing` can
occur, for example, shortly after a service start. The SDK retains the original operation for `403`
and `503` responses. An error does not prove that a refund is complete or
authorize deletion of wallet records. An exact accepted replay returns the
prior admission result. Missing and foreign capabilities have the same response.
A visible order book does not guarantee immediate order admission. Temporary
quote readiness can return `order-processing-unavailable`. This response alone
does not prove insufficient liquidity or require more funding. It also does not
prove that no order was accepted. Retain the original operation and reconcile
its status. An accepted order can also return this response if its result cannot
be returned. It can still settle. Do not create a replacement order from this
response alone. The CLI does not automatically submit the order again after this
response. Any protocol retry must preserve the original request, consent, and
authorization expiry.

The shared closed-market check also returns `market-closed` for deposits.
Framework errors can use another body shape.

## Order lookup

`GET /api/v1/conditions/{conditionId}/orders/by-client-order-id?clientOrderId=`
reads one accepted order of the authenticated owner. The response holds
`orderId`, `marketId`, `status` (`accepted` or `processed`),
`settlementCapability` and `artifactDigest`. A missing order, an order of
another owner and a capability without an accepted order give the same `404`
`order-not-found`. The lookup never stages, verifies or accepts. It has its own
per-subject rate limit, `order-lookup`, of 30 requests a minute.

After an uncertain response or a restart, the wallet uses only this lookup.
It never sends a request that can create the order:

- A found order counts only when its `artifactDigest` equals the digest of the
  local capability artifact. The wallet then records the submitted order.
- Not found before the authorization expiry is not final. The wallet reads
  again after 5 seconds, then doubles the wait after each read, up to 60
  seconds. A `429` from the lookup is not a counted read: the next read waits
  at least until its `Retry-After`.
- At or after the authorization expiry, the wallet reads the mint (NUT-09 and
  NUT-07) and refunds unspent inputs.

## Cancellation and read errors

These order endpoints use the same application Problem Details format.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `order-invalid-request` | The route, condition, or batch cancellation request is invalid. |
| 404 | `order-market-not-found` | The market of a batch cancellation is not registered. |
| 404 | `order-not-found` | The order is unavailable for this request. |
| 409 | `order-cancellation-conflict` | Order state changed during cancellation. |
| 429 | `order-batch-limited` | The application batch cancellation rate limit was reached. |

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

A bound capability does not create an accepted order. Its order-status read
returns `404` with `order-not-found` until an order is accepted. This response
does not authorize an early refund. Keep the original authorization and recovery
rules. After a submission result is committed and available, a later live
notification failure does not replace that result with a submission error.

## Market-funding delivery errors

`POST /api/v1/cashu-deliveries/{deliveryId}` submits an exact delivery.
`GET` on the same path reads its saved status. A failed request does not prove
that no funds were received. Keep the original delivery ID, token, and immutable
request for recovery. Do not create a replacement payment for an uncertain result.
After the engine admits a delivery, it completes the delivery even if the client
disconnects before the response. A later status read returns that result.

The following application errors use `application/problem+json`. Their `type`
is `/errors/{code}`. Use the HTTP status and `code`, not the wording of `detail`.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `cashu-delivery-invalid-request` | Invalid delivery identity or metadata. |
| 403 | `cashu-delivery-forbidden` | The authenticated subject cannot access this delivery. |
| 409 | `cashu-delivery-conflict` | The request conflicts with saved state, or the delivery was rejected. |
| 400 | `market-funding-invalid-request` | Invalid funding amount, unit, token structure, mint binding, or product binding. |
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
Each SDK delivery request waits at most 30 seconds by default.
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
current product supports complementary, mint, and merge conversion. A merge
conversion turns a sell and a sell of the complementary outcome set into
collateral. The mint decides the result of that conversion.

## Confirmation and recovery

The API and settlement notifications use `ExpiredBeforeSubmission` when
authorization expires before submission. `RejectedBeforeSubmission` means
the group stopped before committing a mint request for another reason.
Both have a null `frozenAt`. Neither confirms wallet recovery or authorizes
a refund. Clients read the authoritative order status and keep their recovery
records if that read fails. Only `Confirmed` signals confirmed-result recovery.

While its group settles, a FOK order that reserved its complete amount has the
order status `matched`. The submission response also reports `matched`. Its
`filledAmountSubunits` is the reserved amount, and its `remainingAmountSubunits`
is `0`. After the group is `Confirmed`, the order status is `filled`. If the
group ends in another terminal status, the order status is `failed`. A FOK
order that cannot reserve its complete amount is `cancelled`.

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
