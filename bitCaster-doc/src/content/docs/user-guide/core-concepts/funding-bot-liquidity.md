---
title: "Funding Bot Liquidity"
description: "How a market creator deposits the funds that bootstrap an automated CPMM market maker so the order book has bid/ask quotes from day one."
sidebar:
  order: 5
---

# Funding Bot Liquidity

When you create a market on bitCaster, the order book starts empty. Without makers there is nothing for traders to trade against. To bridge that gap, the matching engine runs an automated **CPMM bot** for every market — a programmatic counterparty that posts both a bid and an ask on the order book and updates them as fills come in. The bot needs initial inventory to quote, and that inventory comes from a deposit you make at the end of the market-creation wizard.

## What you fund

The deposit becomes the bot's working capital for that market. A creator who deposits 10,000 sats lets the bot mint 10,000 YES tokens and 10,000 NO tokens against your condition, and the bot uses both halves of that inventory to quote a two-sided ladder on the book. The bot's price is set by its inventory ratio: as it sells YES the YES inventory shrinks and the YES price rises, exactly as you'd expect from a constant-product maker. Anyone can later add more inventory to the same bot — the deposit endpoint accepts replenishments at any time — so the bot is a long-lived market fixture rather than a one-shot funding round.

The deposit is **non-refundable**. Once you fund the bot, those sats are committed to making liquidity for that market until the market resolves. After resolution the operator is left holding whatever inventory remains plus any sats the bot earned from spreads minus what it paid out in losses. Operationally the design caps your loss at the deposit amount: the bot can never lose more than the inventory it was given. There is no path to claw the deposit back early, and that's intentional — it keeps the bot's commitment to the order book credible from a trader's perspective.

## How the wizard's last step works

After you complete the description step, the wizard registers your condition with the mint, registers the partition, and asks the matching engine to record the market. As soon as the engine acknowledges, the wizard advances to the **Deposit funds** step. You see your new market's identifier and a choice of two payment methods: a Lightning invoice or a Cashu ecash token. Pick whichever you have available — either path funds the same bot.

If you choose Lightning, the wizard requests a `bolt11` invoice from the matching engine. The invoice is shown once in the wizard so you can copy it into your Lightning wallet; for security the invoice is **not** echoed by the polling endpoint, so capture it before you navigate away. Pay the invoice from any Lightning wallet, including a wallet other than the one you're using bitCaster from. After the payment is detected, the deposit moves through `Requested → Paid → Credited` while the matching CTF tokens are minted and credited to the bot's account.

If you choose ecash, the wizard takes a Cashu V4 token blob — paste it into the text area and submit. The proofs are verified against the mint, converted into the right amount, and used to mint the matching CTF tokens for the bot's account. You do not have to be using the same Cashu wallet that you store your trading position in; the deposit is a one-way commitment.

In both flows the wizard polls the matching engine for the deposit's lifecycle state and shows you each transition: awaiting payment, payment received, crediting your market, and finally **funded**. Once you see the funded state, click **Continue to your market** and the wizard navigates you to the market detail page where the bot's ladder is now visible on the order book.

## What if I close the wizard before the deposit completes?

Closing the wizard does not undo the market — it has already been registered with the mint and the matching engine. The market simply exists in an unfunded state until you (or anyone else) deposits. You can return to fund it from the creator dashboard at any time. The market shows zero liquidity until the deposit is credited; no orders can match against the bot until then, but human traders can still post their own orders.

## Replenishing later

Anyone can add inventory to the bot after the market is live — not just the original creator. Replenishment uses the same endpoint and the same flow. This is useful when the bot's inventory has been drained by trading and the spread has widened on the depleted side; topping up restores the ladder to a tighter quote. The matching engine treats every deposit identically, regardless of who paid for it.

The bot does not pause when its inventory runs out on one side. If the YES inventory hits zero, the bot keeps quoting bids (it can still buy YES from traders) but stops quoting asks. Symmetric on the NO side. When both sides exhaust, the bot quietly stops quoting until someone replenishes; it does not terminate. Trading by humans continues regardless.

## Trade-offs to keep in mind

Funding a market with bot liquidity is a **bet on your own market**. If the true probability of YES turns out to be 70% and the bot starts at 50/50, informed traders will sell YES into the bot's ask until the inventory ratio settles at 30/70 — the bot is exactly the counterparty whose money is moving. The bot's spread (the gap between the bid and the ask) is the only protection against this drift, and it widens automatically when the order book's other makers diverge from the bot's price. None of this stops a determined informed trader, but the spread compensates the bot for the risk of being adversely selected before it can update its quotes.

The smaller the deposit, the thinner each price level on the ladder is and the easier it is for a single big trade to walk the price. A larger deposit produces a deeper book that absorbs flow without violent moves. Picking the right size is operator judgment — there is no single right number — but the wizard's earlier liquidity step pre-fills the deposit amount with the figure you chose there.
