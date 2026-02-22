---
title: Frequently Asked Questions
---

## How does bitCaster compare to Predyx?

[Predyx](https://beta.predyx.com/) is a prediction market that uses a traditional **server-side custody** model — your funds sit on their platform, much like a centralized exchange. It relies on an **AMM (automated market maker)** to set prices, which bootstraps liquidity without requiring dedicated market makers but tends to produce wider spreads, especially in markets with many outcomes.

bitCaster takes a fundamentally different approach:

- **Bearer tokens via ecash** — Your positions are [Cashu conditional tokens (CTF)](../technical/nut-ctf/core-ctf/) held as bearer tokens in your browser. The mint cannot see your balance, link your transactions, or freeze individual accounts. However, ecash is still a [custodial model](https://bitcoin.design/guide/how-it-works/ecash/introduction/) — the mint holds the underlying Bitcoin reserves, so you are trusting the mint operator not to abscond with funds or inflate the token supply. The key difference from Predyx is that ecash custody comes with strong privacy (blinded signatures prevent the mint from tracking users) and no accounts or KYC.
- **CLOB matching** — bitCaster uses a central limit order book, which offers tighter spreads when market makers are active.
- **Privacy** — ecash tokens and Lightning leave no public transaction trace. Predyx, as a server-side platform, has full visibility into user activity.
- **Open market creation** — Anyone can create a market by publishing a [DLC oracle announcement](../technical/dlc-oracle/nostr-kind-88/) on [Nostr](https://nostr.com/). Predyx markets are controlled by the platform.
- **Open specs** — bitCaster is built on open protocols ([NUT-CTF](../technical/nut-ctf/core-ctf/), Nostr kind 88, DLC). Predyx uses a proprietary system.

## How does bitCaster compare to Polymarket?

[Polymarket](https://polymarket.com) is the largest prediction market by volume. It settles trades **on-chain on Polygon** using a [hybrid CLOB](https://docs.polymarket.com/developers/CLOB/introduction) — orders are matched off-chain but settled on-chain via smart contracts.

bitCaster differs in several key ways:

- **No blockchain dependency** — bitCaster uses Bitcoin/Lightning and Cashu ecash. There are no gas fees, no bridging from L1, and no need to hold USDC on Polygon.
- **Privacy** — Every Polymarket trade is a public Polygon transaction. bitCaster's ecash model means trades are private by default.
- **Instant settlement** — Ecash token swaps settle instantly within the mint. Polymarket settlement depends on Polygon block times and can involve bridge delays.
- **Open market creation** — Polymarket markets are curated by the platform. bitCaster lets anyone create markets via Nostr and DLC oracle specs.
- **Bitcoin-native** — bitCaster is denominated in sats and connects to the Lightning network via [NWC (Nostr Wallet Connect)](https://nwc.dev/). Polymarket requires USDC on Polygon.

The trade-off: Polymarket's on-chain settlement provides full public auditability of every trade. bitCaster's ecash model trades that auditability for strong privacy, zero gas costs, and instant settlement. It's worth noting that ecash is a [custodial model](https://bitcoin.design/guide/how-it-works/ecash/introduction/) — users trust the mint operator to back tokens with real Bitcoin — but unlike Polymarket's on-chain transparency or a traditional exchange's account system, the mint cannot identify users or track individual balances.
