---
title: 'Trading Model'
description: 'How CLOB orders, authorization, settlement groups, and admission protection work.'
sidebar:
  order: 2
---

# Trading Model

bitCaster uses a central limit order book (CLOB). Liquidity-provider quotes
rest on the book. Public orders take available liquidity within their price
limit. Amounts use msat internally. The UI displays sats.

Public market books use primitive outcome routes. A categorical market exposes
`A / Not A`, `B / Not B`, and similar books. Clients use the market identifier
`{conditionId}-{outcomeName}` and select the required token side.

## First-release public scope

The public server accepts only public FOK orders. The GUI and CLI submit FOK
orders. Each public attempt uses one one-shot capability. FOK uses the book
state at admission. It commits the full requested quantity or cancels the
complete request. Public FAK, GTC, GTD, continuation, and residual
reauthorization are not available.

## Public FOK preview

`POST /api/v1/orders/preview` previews one FOK order. Send `marketId`, `side`,
`tokenSide`, `price`, and `faceAmountSubunits`. Use the selected token's limit
price. The face amount must be a whole tradable unit for the market denominator.
Do not send proofs, an owner, or a time-in-force field.

NIP-98 authentication is optional. The authenticated subject determines the
subject rate-limit partition and self-match exclusion. The preview is read-only.
It does not reserve funds or liquidity. It does not authorize or submit an order.
Final admission checks the current book again with the user's price limit.
The opaque `previewRevision` is display metadata, not authorization.

If the preview cannot fill the order, the browser shows the reason and a
**Refresh quote** action. The result is a snapshot. Refresh checks the current
market without submitting an order. The browser labels a pending wallet funds
and fee check separately from a pending market preview.

The detail page separates settlement checks from wallet recovery. A saved
result can be a partial result. It does not prove that the earlier operation
is complete or that its outputs are still spendable. A new trade can proceed
when current market checks and wallet funds and fee checks pass, and the user
confirms that trade.

The browser hides additional-funding advice while an operation is active,
recovery remains pending, or estimates need refresh. Funding does not resolve
an incomplete wallet operation. Completion and live market events invalidate
estimates. The next response must match the current form and wallet. If an
update is missing, use **Refresh quote** in the trade form or **Refresh market**
beside an empty book. A visible older book does not prove that the next order
can fill.

The response reports full-fill availability and one reason: `fillable`,
`insufficient_liquidity`, `price_limit`, `request_too_large`,
`market_unavailable`, or `temporarily_unavailable`. Recommend a separate subsidy
only when `subsidyMayHelp` is true. Funding and trading require separate consent.

`quotePaymentSubunits` is the exact quote payment in msat, without fees.
`averagePrice` and `worstPrice` describe the selected token. The current
`currentLatestTradePrice` and projected `projectedFinalPrice` describe the
primitive outcome route. Prices use `priceDenominator`. The projected price is
based on the captured preview. For a binary market, `currentLatestTradePrice`
uses the newest confirmed trade from either route in that same preview.
An opposite-route trade maps to `priceDenominator - price`.
For a categorical market with more than two outcomes, only the requested
primitive route supplies this price. A trade in another outcome does not
update it. Clients convert primitive-route prices to the selected token's
price at the display boundary. The projected price is
not a confirmed trade. Execution estimates are `null` when the full amount
cannot fill. The current price is `null` when no confirmed trade exists.
Funding does not create a market-price point.

The GUI uses one Buy/Sell form. It previews the requested quantity over the
full valid price range: `D - 1` for Buy and 1 for Sell.
The user confirms the quoted trade value and reviews fees separately.
The order keeps that accepted total and the preview's worst execution price.
The engine checks the complete current FOK plan before accepting fills.
Equal or better execution can proceed. Worse execution refuses the whole order.

Order acceptance keeps the selected outcome. It clears the submitted quantity
and comment only if the user has not changed the draft. Newer input remains
in the form. A confirmation click or a refused attempt does not clear the
comment. The comment accompanies the signed order.

Buy uses `maxQuotePaymentSubunits` as the maximum trade payment.
Sell uses `minQuotePaymentSubunits` as the minimum gross trade proceeds.
The applicable bound must be a non-negative integer in msat.
The opposite bound is `null`. These bounds exclude fees.
They are engine admission constraints, not independent mint-enforced constraints.
CLI clients can also select a narrower per-fill price limit.

`POST /api/v1/orders/capacity-preview` estimates the maximum quantity at
a selected price limit. Send `marketId`, `side`, and `tokenSide`. Omit `price` for Auto.
Send an integer `price` for Custom. Explicit `null` is invalid.
Auto uses `floor(D * 20 / 100)` ticks and clamps the limit to `1..D-1`.
The result includes all eligible makers, not only the bot.
This API remains available to clients. The browser form does not display a
maximum-capacity number. It checks the entered quantity and explains refusals.
The capacity result excludes wallet balance and fees. It does not reserve
liquidity.

A `ready` result contains `referencePrice`, `effectiveLimitPrice`,
`maxFaceAmountSubunits`, `quotePaymentSubunits`, `worstPrice`,
`priceDenominator`, and an opaque `previewRevision`.
Prices describe the selected token, including a selected complement.
Zero capacity has zero face and quote amounts and a null worst price.
When no eligible maker exists, the reference is null. Auto then has a null
limit; Custom retains the supplied limit. A restrictive Custom limit can
also return zero capacity with a known reference price.
`market_unavailable` and `temporarily_unavailable` have null facts, not zero
capacity. Both preview endpoints share the same preview rate budgets.

Capacity is limited to one public FOK order. Maker minimums can leave gaps:
not every smaller quantity must fill. Continue to use `/orders/preview`
for the entered quantity and calculate its fees separately.

The order keeps the accepted trade total and per-fill price limit through
balance checks, top-up, preparation, submission, and recovery.
It fills the complete quantity within both limits or fills none.
These limits do not reserve liquidity or guarantee execution. If the order no
longer fits, review a fresh preview and confirm a new attempt. The GUI does
not retry the order automatically. Wallet or Nostr setup, or a change of
trading identity, also requires a fresh preview and confirmation.

The trade summary shows `New probability` for the selected outcome. This is the
estimated final execution price. It is not a forecast or the theoretical
post-trade LMSR probability. The current market price stays in the market header.
The summary does not show average, worst, or latest-confirmed token price rows.
The accepted worst per-fill price still protects the submitted order.

For Buy, `Payout if you win` shows the face value of the conditional shares that
the accepted trade will deliver. Use the registered payout denomination. This
value is not net profit. Redemption fees can apply. Sell shows expected proceeds
and no winning payout for sold shares.

One fee summary has a collapsed, accessible breakdown. It groups fees only when
the asset and unit match. Distinct conditional collections stay separate.
A cancelled or failed attempt keeps its reviewed preparation fees in a separate labelled
breakdown. These amounts do not show which fees were paid. A new draft does
not reuse them as current consent. Dismissal, a new attempt, or an identity
change clears this display. After reload, the durable recovery notice states
that preparation and refund fees can apply even when no trade completes.
Zero, pending, unavailable, and changed-fee states remain explicit.
Current fee consent is required before confirmation.

The UI displays amounts in sats: 100 msat is 0.1 sats. Buy cash totals add the quote and
only fees paid in regular collateral. Sell totals
show gross collateral proceeds and net proceeds after the settlement-input fee
and preparation costs paid in regular cash.
Show conditional-token preparation and consolidation fees separately. Do not
add fees in different assets. Unused fee headroom is not a paid fee. If fee
amounts, assets, or preparation mode change, obtain fresh consent before the
next new wallet step. A Sell can use held conditional tokens and regular cash
to prepare the full offered quantity. The cash pays the preparation fee.
The wallet needs this cash before the sale. Future sale proceeds cannot pay it.
Do not use this preparation path to create missing shares.
Price protection does not replace fee consent. Fee consent applies to the
order with the reviewed price bound.

Invalid input returns HTTP `400`. The raw request limit is 16 KiB. Larger bodies
return `413`. Rate or concurrency limits return `429` with `Retry-After`.

## Order authorization

A wallet supplies one `PAY_TO_UNLOCK` capability when it submits a public FOK
order. The engine validates the capability during order admission. It makes no
mint network call during admission.

The capability covers an authorized range for that one attempt. Public FOK does
not rest on the book or leave a residual order. If the complete quantity cannot
fill, the engine cancels the complete request. This cancellation does not spend
the capability or trigger a refund.

## Fills and settlement groups

Each matched quantity creates one fill. `fillId` identifies that real fill.

The engine can group one or more fills into one atomic settlement group.
`groupId` identifies the settlement group. The mint receives one multi-party
conversion for the group. The current product supports complementary and mint
conversion. It does not expose merge conversion in this release.

Mint confirmation returns exact result entries. Clients retain their submitted
operations and confirmed results. They can recover those exact records after a
crash. An acknowledged FOK operation stores its operation facts and result.
These records survive a server restart. An intentional reuse of the same client
order ID with the same operation facts returns the stored result.
Changed facts return a conflict. If the result is uncertain, clients reconcile
with the durable engine and mint authority.

The browser uses completion notifications to recheck pending wallet recovery.
If a recheck is already running, it retains one follow-up request. Work deferred
during an active order attempt resumes when the last active attempt finishes.
An uncertain result keeps its recovery retry. A notification or elapsed time
alone does not make funds spendable. Recovery does not submit a new order.

## Participation Score

Participation Score protects public order admission. A successful public
one-shot capability binding charges once under `settlement-capability-v1`. The
tariff is `1 + InputCount + ceil(ManifestCount/16) +
ceil(ArtifactByteCount/4096)`. Each authenticated invalid proof or DLEQ
validation attempt uses the same tariff. There is no separate order, fill, or
settlement-failure tariff. Fills, cancellation, settlement failure, refund,
and recovery do not debit Score. This tariff applies to public client
capabilities.

If Score is insufficient, the daemon submits a payment and waits for its
delivery state to become `credited` before it prepares the order capability.
Retries use the same delivery identity. Credit can be delayed after the mint
receives the payment. If the bounded wait ends, the payment remains available
for recovery. A pending delivery does not prove that the payment failed.

## Trust boundary

The engine receives the exact `PAY_TO_UNLOCK` proofs that authorize an order.
It sees their secrets and the public blinded-output manifest. It does not
receive the wallet seed, output blinding factors, refund key, or other wallet
proofs.

The engine can use only the authorized selection before expiry. It cannot
redirect value outside the manifest or extend the lock. If it withholds
settlement, the authorized proofs remain unavailable until refund becomes
valid.

The mint performs the conversion. Wallets control their proof material. A
`PAY_TO_UNLOCK` capability can refund after expiry under the NUT rules.

## Comparison with on-chain CTF exchanges

The names complementary, mint, and merge also appear in on-chain CTF systems.
The implementation differs. bitCaster currently exposes complementary and mint
conversion only. It uses one mint conversion for an atomic settlement group. It
does not use a peer-to-peer settlement exchange or an on-chain operator
transaction.
