---
title: Technical Reference
sidebar:
  order: 0
---

This section describes the public technical behavior of bitCaster.

The first-release server accepts only public FOK orders. The GUI and CLI submit
FOK orders. Each public attempt uses one one-shot capability. FOK uses the book
state at admission. It commits the full requested quantity or cancels the
complete request. Public FAK, GTC, GTD, continuation, and residual
reauthorization are not available. Internal custody-backed LMSR quotes use GTC.
They are not public client orders.

## Settlement groups

Orders use `PAY_TO_UNLOCK` capabilities. Order admission makes no mint network
call. The engine groups one or more fills into an atomic settlement group and
submits one multi-party mint conversion for that group.

`fillId` identifies one real fill. `groupId` identifies one atomic settlement
group. A confirmed group returns exact mint result entries. Clients persist and
recover their submitted operations and confirmed results. An acknowledged FOK
operation stores its operation facts and result. These records survive a server
restart. An intentional reuse of the same client order ID with the same
operation facts returns the stored result. Changed facts return a conflict.

The engine receives only the exact input proofs and public output manifest that
the wallet authorizes for an order. It does not receive the wallet seed, output
blinding factors, refund key, or general proof inventory. See
[NUT-CTF Range Settlement](/technical/protocol/atomic-swap/) for the protocol
details.

## Portfolio monitoring API

The authenticated `GET /api/v1/portfolio` endpoint returns display-only data
for the first portfolio render. The response includes the active wallet summary,
the first asset page, and the selected value history. It does not prove custody
or authorize spending.

Use the returned asset cursor with `GET /api/v1/asset-monitoring/assets` to
read later pages. Do not call the portfolio endpoint for continuation pages.
Private responses use `Cache-Control: no-store`. The API returns `400` for an
invalid query, `409` for an inactive wallet, `429` when the history-read limit
is full, and `503` when the active provider has no bounded monitoring reader.

After a confirmed settlement, an owner-filtered
`SettlementGroupStateChanged` update can refresh the active portfolio. This
best-effort display update does not prove custody or authorize spending.
