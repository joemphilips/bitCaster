---
title: 'Web app: display rules and privacy'
description: 'How the web app derives prices and estimates, when comments appear, and which third parties it contacts.'
sidebar:
  order: 8
  label: 'Web app notes'
---

## Prices and market status

Every market outcome has a corresponding token. A public market price comes
from the latest confirmed trade. Before the first confirmed trade, the market
has no price, so the app shows **No trades yet** or an em dash. Prices from
confirmed trades are shown as probabilities with one decimal place, such as
**53.3%**. A bid/ask midpoint is an order-entry reference only.

After trading closes, the market header shows **Awaiting resolution** until
the engine has the verified result. Then it shows **Resolved** and the final
outcome. A closed trading status alone does not resolve a market. Market cards,
Portfolio, the creator dashboard, and profile pages use the same two terms.

The market chart shows recorded trades for each primitive outcome. If only one
outcome has traded, only that line is shown; bitCaster does not invent prices
for outcomes that have not traded. Before any confirmed trade, the market
shows **No trades yet** or an em dash.
During the first load, an unpriced binary or categorical chart uses the
**Price Chart** heading.

## Estimated position values

Portfolio uses confirmed trade prices to estimate position values. With two
outcomes, the latest trade on either outcome updates both estimates. The other
outcome uses 100% minus that price. For example, a latest Yes trade at 28%
gives a No estimate of 72%; a latest No trade at 72% gives a Yes estimate of 28%. With
three or more outcomes, a No position uses 100% minus its outcome's price. For example,
if B last traded at 28%, No B is estimated at 72% of its winning payout.
This estimate is not a guaranteed sale price. Use the Sell preview to check
what an order can receive.

A closed winning position shows its payout value, not profit. Portfolio does
not report a profit amount or percentage because it does not have the purchase
cost for that position.

A position without a usable price stays visible. Its value and the complete
portfolio total are unavailable, not zero. The app reports missing prices
separately from data that is still updating. Missing historical prices can
make the chart unavailable without hiding a valid current estimate.

## Trade comments

Trade comments are optional and public inside bitCaster. A comment is shown only after the attached order produces a settled trade, so the comment feed is limited to verified traders for that market. P20 comments are not published to public Nostr relays.
A comment above 280 characters shows an error and blocks the order.

## Oracle profile pages

Select the oracle in the market header to open its profile page. The page
shows what the selected Nostr relays return for this key: the banner, the
picture, the name, the description, and the follow count. Then it lists the
markets created by this key, and after them the latest notes. A NIP-05
address appears only when its domain confirms that the address belongs to
this key.

An optional profile indexer, the Primal cache service, adds the follower
count and the date when the indexer first saw activity for this key. The page
names Primal as the source of these values. This date does not prove the age
of the key. If the indexer does not answer, the page does not show these
values. To stop the indexer request, turn off **Profile indexer** in Nostr
Settings.

The selected relays also receive the key of each profile that you open.
The bitCaster engine also receives the key to list the markets created by it.
Primal runs one of the default relays. The setting stops only the indexer
request, not the relay requests. The browser loads the images and the NIP-05
check from the hosts that the profile names. It contacts no host for a PNG,
JPEG, GIF, WebP, or SVG picture that the profile embeds as a `data:` URI. The
page does not show other `data:` content. The relays, the indexer and
these hosts see your IP address and the profile that you open. A long
history and real followers help you judge the identity. They do not prove
that a result is true.

## Nostr profile pictures and relays

Choose **Choose image**, or drop one image into the picture area. JPEG, PNG, and
WebP files can contain up to 5 MiB and 16 million pixels. The browser reduces each
side to at most 1024 pixels and re-encodes the image without its original metadata.
The upload goes to the public nostr.build service with your Nostr signer.
Uploading does not publish the profile. Choose **Save profile** to publish its URL.
You can still enter an existing HTTPS image URL instead.
The card also shows a PNG, JPEG, GIF, WebP, or SVG picture that the profile
embeds as a `data:` URI. Other `data:` content does not appear.

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

## Switch between environments

When configured, the user menu includes **Go to testnet** or **Go to mainnet**.
The link opens the other environment in a new tab. It does not transfer your
wallet, keys, login state, or backups. Each environment keeps its own browser
state. If no destination is configured, the menu has no environment link.
