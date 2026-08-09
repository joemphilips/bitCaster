---
title: Technical Reference
sidebar:
  order: 0
---

This section covers the technical architecture and protocol details behind bitCaster. It is intended for developers and technically inclined readers who want to understand how the system works under the hood.

## Portfolio monitoring API

The authenticated `GET /api/v1/portfolio` endpoint returns display-only data for the first portfolio render. The response includes the active wallet summary, the first asset page, and the selected value history. It does not prove custody or authorize spending.

Use the returned asset cursor with `GET /api/v1/asset-monitoring/assets` to read later pages. Do not call the portfolio endpoint for continuation pages. Private responses use `Cache-Control: no-store`. The API returns `400` for an invalid query, `409` for an inactive wallet, `429` when the history-read limit is full, and `503` when the active storage provider has no bounded monitoring reader.

After a confirmed settlement, the authenticated `TradeHub` sends `PortfolioInvalidated` with the affected wallet ID. The GUI ignores notifications for other wallets and fetches `GET /api/v1/portfolio` one time. This notification is best effort and display-only. It does not prove custody or authorize spending.
