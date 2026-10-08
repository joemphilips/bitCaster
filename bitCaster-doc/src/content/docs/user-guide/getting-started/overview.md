---
title: 'bitCaster 101'
description: 'What is bitCaster and what can you do with it?'
sidebar:
  order: 1
---

## What is bitCaster?

bitCaster is in development. There is no production deployment.
Do not use real funds with development or test instances.

bitCaster lets you buy and sell shares in the possible outcomes of an event.
For example, a market can ask whether Alpha, Beta, or Gamma will win an election.
In an ordinary market, each share in the winning outcome pays 1 sat.
Shares in losing outcomes pay nothing. Before the result is known, trade
prices can rise or fall. A correct prediction does not guarantee that you can
sell at a profit before the market resolves.

The browser serves casual participants and market creators. Professional and
automated traders can use the CLI, daemon, and SDK. Every client uses the same
order book and settlement protocol.

The command-line interface (CLI) is also intended for your own graphical
interface (GUI), terminal interface (TUI), scripts, or trading AI agents.
It is an application interface, not just a debugging tool.
The design goal is to expose every web-app operation and its required data
through the CLI. Command coverage is still incomplete during development.
Use `bitcaster-cli --help` to check the available commands.

The browser app and protocol specifications are public. The matching engine
is closed source. Your wallet stores Cashu ecash tokens in your browser.
The web app can store an encrypted recovery copy that the server cannot
decrypt. See [Encrypted wallet backup](/user-guide/getting-started/wallet-backup/)
for its limits.

For an overview of Cashu itself, see the [Bitcoin Design guide on ecash](https://bitcoin.design/guide/how-it-works/ecash/introduction/).

## What you can do

### Buy and sell market shares

Choose a market, an outcome, and how many shares to buy or sell.
Review the quoted cost or sale proceeds and the separate fees before confirming.
The order cannot buy for more, or sell for less, than the trade value you accept.
Equal or better execution is allowed. If the current orders give a worse deal,
the whole order is refused. Review a fresh quote before confirming a new order.
The estimated last fill price describes the last match in your proposed order.
It is not a promise of the next orderbook midpoint.
The form checks your entered quantity and its fees. It warns when the current
orders cannot fill that quantity within your price limit. A preview does not
reserve liquidity. Your order fills in full
within the limit or does not fill. It does not stay on the order book for later.
Markets can have two outcomes, such as Yes and No, or up to eight named
outcomes. You can fund your wallet through a Lightning invoice or with an
existing Cashu token from the supported mint. The app shows amounts in sats.
Small amounts can have decimal places. Compact balance and market summaries
show these digits in smaller text. The amount stays exact.

Check the selected outcome before confirming. In the example above, Alpha
means that Alpha wins. Not Alpha means that Beta or Gamma wins.

After settlement, Activity shows each confirmed fill for the active wallet.
When the order is known, Activity groups its recorded fills in one expandable
row. Expand the row to see each fill's outcome, shares, and trade value before
fees. This value is not the net change in your wallet balance. A group does not
mean that the whole order has completed. Fills without a known order stay
separate. A pending or failed order does not appear as a completed trade.

Activity links to the market and shows its title when available. If the title
cannot load, the row shows a short market reference. Each fill shows its
historical price per share. An order group shows the average price weighted by
the number of shares. These prices use recorded trade values, not the current
market price. Rounded prices have an approximate label. Very small positive
prices show a below-precision label instead of zero. The price label also
provides the exact ratio. Older records without the required amounts show no
execution price.

Positions with a confirmed result show “Won😋” or “Lost😭”. The text identifies the result;
the emoji is decorative. Activity labels a received payout as “Payout Claimed”. Removing a losing position permanently deletes its
local tokens. The confirmation warns that this action cannot be undone.

### Create your own market

Define the question, the possible outcomes, and how the result will be decided.
Market creation does not require a funding payment or an opening probability.
It does not set a market price.

You can fund the market-making bot after creation. You can add funding more
than once. This funding is a non-refundable subsidy, not an investment that
gives you shares, fees, or a right to withdraw. Keep it separate from funding
your own trading wallet. If there is no available liquidity, the trade form
directs you to the Liquidity tab. When all outcome books are empty, Buy and
Sell show that message instead of an order form. A missing or failed book
request is not treated as an empty market.

### Become an oracle

In prediction markets, the value of a token depends on what actually happens in the real world. An oracle is the referee that determines that real-world outcome — which can sometimes be ambiguous.
Anyone can become an oracle. The oracle is designated when a market is created and cannot be changed afterward.
A valid oracle signature identifies who signed the result. It does not prove that the result is true. bitCaster does not provide an oracle trust score. See [Resolution](../../core-concepts/resolution/) for details.

When a market's oracle key is a Nostr public key, you should audit the oracle yourself before trading. Copy the market's oracle `npub` from the market detail page and check that identity's history and credibility in your preferred Nostr client. The copy button shows a success notification after the clipboard write finishes. If copying fails or the clipboard is unavailable, it shows an error.

### Use the supported mint

The first release supports one Cashu mint operated by bitCaster.
Native CLI settings can save and select mint endpoints.
These settings do not extend trading support to another mint.
Changing the selected endpoint does not move or convert existing funds.
Keep access to the original mint for its funds and unfinished operations.
The mint software and protocol specification remain public.

## How it works

Every market outcome has a corresponding token. A public market price comes
from the latest confirmed trade. Before the first confirmed trade, the market
has no price, so the app shows **No trades yet** or an em dash. Prices from
confirmed trades are shown as probabilities with one decimal place, such as
**53.3%**. A bid/ask midpoint is an order-entry reference only.

Enter a whole number of shares. Review the quote payment, itemized fees, and
total payment or net proceeds before you submit. For example, buying 50 shares at 30.0%
costs 15 sats before settlement fees. Those shares pay 50 sats if they win.
The displayed percentage is a trade price, not a guarantee about the event.

When the event resolves, winning tokens can be redeemed. Losing tokens have
no payout. You rely on the oracle to report the result correctly and on the
mint to honor redemptions. If the mint stops service, trading or redemption
can be delayed. Holding your wallet keys does not remove this mint risk.

Cashu protects token ownership from the mint at the protocol level. It does
not make all app activity anonymous. The matching engine can associate your
authenticated activity with your account. Encrypted backup protects wallet
contents; it does not hide all account or activity metadata.

## Your assets, your responsibility[^1]

Your tokens are just signed data. The live wallet database is in your browser's
local storage. The default web app also keeps an encrypted recovery copy whose
contents the server cannot read.

This minimizes the wallet information held by the server. The encrypted-backup
service can still observe limited account, size, and activity metadata. It
cannot decrypt or spend your funds.

Like any other cryptocurrency wallet, you are responsible for managing your own
keys. Back up your 12-word mnemonic and keep it safe.

Before your first wallet action, choose Create wallet or Restore wallet.
A new wallet is generated locally in your browser. To restore a wallet, enter
a valid 12-word recovery phrase. Setup does not submit a payment automatically.
Recovery-phrase and backup controls are available only when a wallet exists.

If no wallet exists, open Settings, then Cashu Settings, and select Create Wallet.
Use the chooser to create a wallet or import a valid 12-word recovery phrase.
This does not change your Nostr signer or submit a payment or order.
Create Wallet is hidden when a recovery phrase exists, even with no funds or mints.
Closing setup after creation starts does not remove an already saved recovery phrase.

To use another wallet, open the wallet section in Settings and import its
recovery phrase. This replaces the active wallet; it does not add a second
named profile. Save the current recovery phrase first. Unfinished wallet work
or an incomplete backup can block replacement. Your Nostr account does not
change. Activity stays associated with the wallet that performed it.

Your Nostr signing key is a separate secret. Back up both the wallet recovery
phrase and any Nostr secret key shown in the app. If you already use a Nostr
account, connect it instead of generating a new one.

Before connecting a Nostr browser extension, the app explains its capability
limit. Market creation needs a local Nostr private key for oracle signing.
Other supported features can use the extension. Select OK to request the
extension identity, or Cancel to keep the current state. Connection stays
pending until the extension returns a valid identity. A saved identity after
reload does not mean that the extension has authorized the connection.
Disconnect cancels pending connection work. Disconnect before switching from
an extension to a local private key.

Settings and Portfolio show the same connected Nostr profile card.
The card shows your picture, display name, and description. Settings also has
a refresh control. An unavailable relay read is different from an absent profile.
In Nostr Settings, choose **Edit** to change your name, description, and picture URL.
Choose **Save profile** to publish the changes. Choose **Cancel** to discard an
unsaved draft. These fields are public. The app publishes standard Nostr profile metadata with your connected
local key or supported browser extension. It does not host picture uploads.
Other metadata stays unchanged. A separate display name set in another client
can still take priority over the name you edit here.

Save first reads all selected relays. If a read or signature request fails,
your draft stays available. A relay rejection and a missing acknowledgement
are different results; a missing acknowledgement does not prove rejection.
If publication succeeds but local retention fails, the app reports both facts.
After a successful durable save, this client preserves that metadata when a
later relay reply is older. This does not prevent concurrent edits on other devices.
Profile names and NIP-05 address claims are not proof of identity.
Use only your saved relay destinations. An empty relay list is an explicit
opt-out from Nostr relay traffic, not a request to use fallback relays.
Liked markets and other preferences are not a backup of wallet funds.

The native CLI uses separate wallet profiles instead of replacing one in place.
Select a profile with `--datadir`. Import seed and signer files only into a fresh
profile. Keep the old profile while it has funds or unfinished work.
Initialization imports keys; it does not recover funds.
`wallet recover-seed` requires explicit acknowledgment of seed-candidate disclosure
to the mint. See [CLI wallet and signer commands](/technical/#select-and-import-a-native-wallet-profile).

### When wallet backup pauses an action

Wait while **Preparing wallet backup** is shown. Do not keep pressing Continue.
Top-up and other new wallet changes stay paused until backup preparation or recovery completes.
If **Wallet backup stopped** is shown, use **Retry wallet backup**.
If **Wallet actions are paused** is shown, follow its reason and use **Retry recovery**.
Close an unused second wallet tab when the message asks you to do so.
Sign in or reload when the message says the backup driver is unavailable.
Keep the page open while a retry is pending.
Retrying does not guarantee that unresolved work or an unpaid invoice is cleared.
The local wallet keeps its funds and unfinished work while recovery is incomplete.
Do not delete wallet data or start another payment to bypass the pause.

## Switch between environments

When configured, the user menu includes **Go to testnet** or **Go to mainnet**.
The link opens the other environment in a new tab. It does not transfer your
wallet, keys, login state, or backups. Each environment keeps its own browser
state. If no destination is configured, the menu has no environment link.

## Find a market

Use search, tags, and filters on the market list. The controls stay available
while results load, when loading fails, and when no markets match. Use
**Clear all** to remove the search text, selected tags, and filters.

Tag counts and advanced filters apply to the loaded results, not the whole
catalogue. Load more results when you need to look further.

Save a market as liked to find it again. The CLI provides `market liked`,
`market like`, and `market unlike`. Use `market liked --local` to read saved IDs
without relay or catalogue requests. These preferences can be public on relays.
See [Liked markets and live watches](/technical/#keep-liked-markets) for command details.

## Market detail pages

The market chart shows recorded trades for each primitive outcome. If only one
outcome has traded, only that line is shown; bitCaster does not invent prices
for outcomes that have not traded. Before any confirmed trade, the market
shows **No trades yet** or an em dash.

The line continues at the latest confirmed price to the chart edge.
This extension does not represent a new trade. The endpoint glows gently.
The chart disables motion when your device requests reduced motion.

When you point at a historical date, the price is the last confirmed trade at
or before that date. Pointer height does not set the price.
An outcome with no confirmed trade at or before that date has no available price.
Categorical lines connect confirmed points across alignment gaps.
Those connections do not add trades or invent prices for untraded outcomes.

After a buy or sell, the chart keeps the confirmed prices and history that it
has already loaded while newer data arrives. A message shows when the data is
updating or its refresh failed. A failed refresh does not mean that the market
has no trades. If no valid data has loaded, the chart shows an unavailable state.

A previously traded market can have no trades in the selected period. The chart
then shows **No trades in this period**. Its current price still comes from the
latest confirmed trade. Categorical price labels show each outcome's latest
confirmed price when you are not pointing at history.

The order book shows asks (sell orders) above the spread and bids (buy orders)
below it, with the best prices closest to the spread. Each row combines price,
cumulative depth, and visual thickness. Longer bars mean more cumulative
liquidity available at that price or better, normalized across both sides so
you can compare bid and ask depth at a glance. Market cards and detail pages
show **Total funding** after receive fees for funded markets. New confirmed
payments increase it. Trades do not reduce it. It is not current order-book
liquidity.

Trade comments are optional and public inside bitCaster. A comment is shown only after the attached order produces a settled trade, so the comment feed is limited to verified traders for that market. P20 comments are not published to public Nostr relays.

Chart comment bubbles point to the time and price of the associated confirmed
trade. The pointer stays on that trade when new prices arrive or the chart
size changes. Hover over or focus a bubble to expand it into a comment card.
Click or tap to keep the card open. Press Escape or use its close button to close it.
Opening a comment keeps the latest price visible. Move over the chart without
an open comment to inspect a historical price.
The chart selects up to ten comments in the period, ranked by their linked
confirmed trade size. Comments with a known size come first. Each collapsed
bubble shows about twenty characters of text. The expanded card shows the
author and date, with scrolling for long text. Likes increase opacity, not size.
A comment stays
in the comment list when its trade point is unavailable or outside the chart
view. The list shows when the comment was written.

Each expanded chart comment shows its public author, text, and written date. The author
is the public key that signed the comment. If a public Nostr profile is
available, the app shows its display name. Otherwise, it shows a shortened
public key. Profile lookup does not block the market page. A profile name is
display information, not proof of identity.

## Getting started

Before you fund a wallet, read
[Encrypted wallet backup](/user-guide/getting-started/wallet-backup/).
Keep your recovery phrase safe. Then review the market's question, oracle,
and resolution rules before your first trade. Optional market creation and
bot funding can wait until you understand the trading flow.

[^1]: Note that ecash tokens are not strictly self-custodial. See https://iscashucustodial.com/ or https://bitcoin.design/guide/how-it-works/ecash/introduction/, https://stacker.news/items/793450 for details.
