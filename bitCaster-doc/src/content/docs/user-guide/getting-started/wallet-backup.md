---
title: 'Back up your wallet'
description: 'The two secrets to keep safe, and how to move your wallet to a new browser.'
sidebar:
  order: 3
---

You have two secrets to look after: the recovery phrase of your wallet, and your Nostr key. Neither one can restore the other.

:::caution
The beta does not run the encrypted backup service yet. Your recovery phrase is the only backup of your wallet.
:::

## The recovery phrase

Your wallet's 12-word recovery phrase is in Settings, under Cashu. Write it down and keep it offline. Anyone who has the phrase can spend your funds, so never share it, not even with support.

## Moving to a new browser

Choose Restore wallet in the new browser and enter the phrase. The app then restores your funds and your market positions from the mint by itself. With many markets this can take a few minutes.

Two habits keep this safe. First, let open trades finish before you move, because only the old browser can complete or refund an order that is still in progress. Second, use one browser at a time.

Restoring shows the mint which tokens belong to the same phrase. It still does not learn your Nostr identity.

## Don't clear site data mid-trade

While a trade, payment, or refund is unfinished, the browser holds records that the phrase cannot rebuild. If something looks stuck, leave the browser data alone and let the wallet finish. Clearing it can lose the funds involved.

## Your Nostr key

Your Nostr key is your identity on bitCaster. It identifies you to the matching engine, and it signs your comments and the results of the markets you create. It is separate from the wallet, and the recovery phrase does not restore it.

If the app generated the key for you, open Settings, then Nostr, then **View nsec**, and store a copy somewhere private. If you use a browser extension, back the key up there. Market creators should take extra care: without the key, you cannot report the result of your own market.

## Further reading

[Wallet backup and recovery](/technical/reference/wallet-recovery/) has the precise rules, the encrypted backup design, and emergency recovery with the CLI.
