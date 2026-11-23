---
title: 'Market Resolution'
description: 'Who decides the result of a market, how winners get paid, and what can go wrong.'
sidebar:
  order: 3
---

When an event is over, the market's **oracle** signs the result. The mint checks that signature. From then on each winning share can be exchanged for 1 sat, and losing shares are worth nothing. This is called resolution.

## Who decides

The oracle does, and nobody else. Every market names its oracle before you trade, and the oracle can never be changed afterwards. Today the person who creates a market is also its oracle.

bitCaster reuses the oracle model of [Discreet Log Contracts (DLC)](https://www.dci.mit.edu/projects/discreet-log-contracts). The oracle announces an event in advance and signs exactly one result later. If it ever signs two different results for the same event, the mathematics exposes its private key.

A valid signature tells you who reported the result. It does not tell you that the result is true. bitCaster gives oracles no trust score, so the judgment is yours.

### Check the oracle profile

Select the oracle in the market header to open its profile page. You will see its Nostr profile, the markets it has created, and its recent notes. A long history and real followers are good signs, although they prove nothing by themselves.

Opening a profile asks your Nostr relays about that key. An optional profile indexer run by Primal adds the follower count. To stop that extra request, turn off **Profile indexer** in the Nostr settings.

## Our approach to the oracle problem

Deciding what counts as the "correct answer" is known as the [oracle problem](https://chain.link/education-hub/oracle-problem). Polymarket hands it to [UMA's optimistic oracle](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work), where a result can be disputed and is finally settled by a vote of token holders.

We think that hides the problem instead of solving it. Responsibility is spread across a governance process. Anyone who gathers enough voting power can steer a result. And beneath the vote sits one more layer, the stakers of the chain itself, whom most traders never think about.

bitCaster takes the opposite stance and makes it obvious who is responsible. The oracle is one named key. What it loses by lying depends on who it is: its reputation, its key, perhaps a contract. But you always know who signed, and what they said.

## From close to payout

A market closes when its oracle's result arrives or when its deadline passes, whichever comes first. If the deadline comes first, the market shows **Awaiting resolution** until the oracle reports. Then it shows **Resolved**.

To collect, open your [Portfolio](https://bitcaster.market/portfolio) and choose **Cash out** on a winning position. The CLI [claims your payouts on its own](/technical/reference/resolution/#using-the-cli) while it runs, even when the matching engine is down. Your winnings arrive as ordinary ecash, which you can withdraw over Lightning. Don't wait forever, because the mint may redeem winning shares only for a limited period.

## If the oracle never reports

There is no automatic refund in this release. The mint operator may decide on a refund under its published policy, but a missed deadline guarantees nothing. Choosing a reliable oracle matters more than anything else on this page.

## Reporting a result yourself

If you created the market, open **Your Markets** on the [creator page](https://bitcaster.market/creator), choose **Close market**, and pick the winning outcome. A saved choice cannot be changed. See [Creating markets](/user-guide/core-concepts/creating-markets/).

## Further reading

[Reporting results and claiming payouts](/technical/reference/resolution/) has the precise rules, including the CLI commands.
