---
title: "Atomic Swaps for Conditional Tokens"
description: "Trading protocol for Cashu conditional tokens using ECDH key agreement and adaptor signatures over NUT-11 P2PK spending conditions."
sidebar:
  order: 5
---

# Atomic Swaps for Conditional Tokens

This document specifies a peer-to-peer trading protocol for Cashu conditional tokens (NUT-CTF) using ECDH key agreement and Schnorr adaptor signatures. The protocol enables trustless atomic exchanges — for example, trading YES outcome tokens for sats — without requiring a custodial intermediary.

## Motivation

NUT-CTF defines conditional tokens whose value depends on future outcomes, but does not specify how users trade them. A prediction market requires two components: (1) a matching engine to pair buyers and sellers, and (2) a settlement mechanism to atomically exchange tokens so that neither party can cheat.

This protocol addresses (2) by constructing an atomic swap from NUT-11 P2PK spending conditions, ECDH-derived shared secrets, and Schnorr adaptor signatures. The matching engine (1) is a non-custodial relay that facilitates pubkey exchange and encrypted message passing.

## Background

### Adaptor Signatures

An adaptor signature scheme extends a standard signature scheme with four operations:

- **PreSign(sk, m, T) → s'**: Produce a _pre-signature_ `s'` on message `m` using secret key `sk` and adaptor point `T = t·G`. The pre-signature is not a valid signature, but it commits to the secret `t`.
- **PreVerify(pk, m, s', T) → bool**: Verify that `s'` is a valid pre-signature relative to public key `pk`, message `m`, and adaptor point `T`.
- **Adapt(s', t) → s**: Given the adaptor secret `t`, complete the pre-signature into a valid Schnorr signature `s = s' + t`.
- **Extract(s, s') → t**: Given a valid signature `s` and the corresponding pre-signature `s'`, recover the adaptor secret `t = s - s'`.

The key property is: if a pre-signature `s'` is published and later the completed signature `s` appears (because someone spent the proof), anyone who knows `s'` can extract `t`. This creates a cryptographic link between two independent spending events.

For Schnorr signatures on secp256k1 (as used by NUT-11), adaptor signatures are straightforward:

```
Standard Schnorr:   s = r + e·x           (where e = H(R, P, m))
Adaptor pre-sig:    s' = r + e·x          (but R' = R + T, so e = H(R+T, P, m))
                    s = s' + t             (valid sig with nonce point R = R' - T)
```

### Why Adaptor Signatures Must Operate at the P2PK Layer

Cashu's blind signature (BDHKE) uses multiplicative structure: `C_ = k · B_`. Adaptor signatures require additive structure (Schnorr: `s = r + e·x + t`). You cannot embed an adaptor secret into the multiplicative blind signature without breaking mint verification or invalidating NUT-12 DLEQ proofs.

NUT-11 P2PK spending conditions already use Schnorr signatures on secp256k1, which is fully compatible with adaptor signatures. The protocol therefore operates entirely at the spending condition layer, not the blind signature layer.

### ECDH Key Agreement

Two parties with keypairs `(a, A = a·G)` and `(b, B = b·G)` can compute a shared secret `S = a·B = b·A` without either party revealing their private key. This shared secret establishes an encrypted channel for exchanging adaptor points and pre-signatures, even when communication is relayed through an untrusted matching engine.

## Protocol

### Participants

- **Alice**: Sells YES tokens (holds conditional token proofs she wants to exchange for sats)
- **Bob**: Buys YES tokens (holds sat proofs he wants to exchange for conditional tokens)
- **Matching Engine (ME)**: Non-custodial relay that pairs orders and forwards encrypted messages
- **Mint (M)**: Cashu mint that enforces P2PK spending conditions

### Prerequisites

- Both Alice and Bob hold Cashu proofs with valid DLEQ proofs (NUT-12)
- The mint supports NUT-07 (token state check with witness retrieval), NUT-11 (P2PK), and NUT-12 (DLEQ)
- Alice's YES token proofs and Bob's sat proofs have compatible denominations for the agreed trade

### Step 1: Order Placement

Alice and Bob each generate an ephemeral keypair and register orders with the matching engine.

```
Alice: generates (a, A = a·G), registers sell order with pubkey A
Bob:   generates (b, B = b·G), registers buy  order with pubkey B
```

The matching engine stores orders in its book. Ephemeral keys ensure unlinkability across trades.

> **Key hygiene**: A fresh keypair MUST be generated per distinct swap. Within a single order that fills against multiple counterparties (partial fills), an implementation MAY reuse the order-level keypair across those fills, but this is a known linkability weakness and should eventually move to per-fill keys. Reusing keys across unrelated swaps leaks the ECDH shared-secret graph and is prohibited.

### Step 2: Match

The engine matches Alice's sell order with Bob's buy order based on price and quantity. It sends:

- Alice receives Bob's pubkey `B`
- Bob receives Alice's pubkey `A`

The matched quantity is the conditional-token face amount. The settlement
message also carries the quote payment separately. For example, a 1,000-face-sat
YES fill at price 37 means Alice locks 1,000 face sats of YES and Bob locks 370
regular sats. Implementations must not use one amount for both swap legs.

For complementary matches, the order book first creates a reservation, not a
final fill. The public order status exposes that row as `status: matched` with a
`tradeId`; once both parties complete the atomic swap the reservation commits
and becomes `status: filled`. If the settlement timeout expires first, the
engine fails the trade and releases the reservation as `status: released`.
Release is time-in-force aware: GTC/GTD quantity may return to the book under
the same order-level ephemeral key because reuse across partial fills of the
same order is allowed, while FAK/FOK orders are cancelled instead of resting
again. The timeout must be scheduled after the seller-side locktime plus a
grace window; timing out at the buyer-side locktime can abort a swap that is
still valid on the protocol timeline.

For a resting buy that can become the complementary maker, clients SHOULD
pre-flight split before order submission. The maker selects regular sats,
submits a CTF split to the mint for the complete outcome set, stores the
resulting outcome proofs in local wallet state, and reserves both the keep side
and the complementary lock side under the order. If the mint is unavailable or
the client cannot reserve enough collateral within the user-visible submission
window, the client SHOULD fail submission or cancel/release the order path
rather than publish a maker order that cannot settle. Implementations may expose
an explicit opt-out, such as `--no-preflight-split`, but then they must reserve
regular collateral and fail closed if it is unavailable when the match arrives.

Pre-flight split is a wallet-local safety mechanism, not a different wire
protocol. When a complementary match arrives, the maker still acts as Alice in
the seller branch below: the reserved complementary outcome proofs are locked to
the taker, while the maker's kept outcome proofs become visible only for the
matched quantity. For partial fills, remaining pre-split proofs must stay
reserved for the unfilled order quantity.

### Step 3: ECDH Shared Secret

Both parties independently compute the shared secret:

```
Alice: S = a · B
Bob:   S = b · A
```

They derive a symmetric encryption key from `S` (e.g., `key = SHA256(S)`) for encrypted communication through the engine. The engine relays ciphertexts but cannot decrypt them.

### Step 4: Adaptor Point Generation

Alice generates a random adaptor secret `t` and computes the adaptor point `T`:

```
Alice: t ← random scalar
       T = t · G
```

Alice sends `T` to Bob over the ECDH-encrypted channel (relayed by the engine).

### Step 5: Alice Locks YES Proofs

Alice creates her YES token proofs locked to Bob's pubkey using NUT-11 P2PK:

```json
[
  "P2PK",
  {
    "nonce": "<random>",
    "data": "<Bob's pubkey B>",
    "tags": [
      ["sigflag", "SIG_INPUTS"],
      ["locktime", "<unix_timestamp>"],
      ["refund", "<Alice's pubkey A>"]
    ]
  }
]
```

The `locktime` and `refund` tags ensure Alice can reclaim her tokens if Bob never completes the swap.

Alice then creates an adaptor pre-signature on each proof's secret:

```
For each proof with secret x_i:
  s'_A_i = PreSign(a, x_i, T)
```

> **Note:** The pre-signature is created with an ephemeral key that Bob will use to verify, and uses adaptor point `T`. It is _not_ a valid Schnorr signature until adapted with `t`.

Alice sends `{proofs, s'_A, T}` to Bob over the encrypted channel.

### Step 6: Bob Locks Sat Proofs

Bob receives Alice's locked proofs and verifies:

1. **DLEQ verification** (NUT-12): Confirms each proof carries a valid mint signature
2. **P2PK verification**: Confirms proofs are locked to his pubkey `B` with appropriate locktime and refund to `A`
3. **PreVerify**: Confirms each `s'_A_i` is a valid adaptor pre-signature with adaptor point `T`

If all checks pass, Bob creates his sat proofs locked to Alice's pubkey `A`:

```json
[
  "P2PK",
  {
    "nonce": "<random>",
    "data": "<Alice's pubkey A>",
    "tags": [
      ["sigflag", "SIG_INPUTS"],
      ["locktime", "<unix_timestamp>"],
      ["refund", "<Bob's pubkey B>"]
    ]
  }
]
```

Bob creates adaptor pre-signatures on his proofs using the same adaptor point `T`:

```
For each proof with secret y_j:
  s'_B_j = PreSign(b, y_j, T)
```

Bob sends `{proofs, s'_B}` to Alice over the encrypted channel.

### Step 7: Alice Claims (Adapt + Swap)

Alice verifies Bob's proofs (DLEQ, P2PK lock to `A`, PreVerify of `s'_B`).

Alice knows `t`, so she can adapt Bob's pre-signatures into valid Schnorr signatures:

```
For each of Bob's proofs:
  s_B_j = Adapt(s'_B_j, t) = s'_B_j + t
```

Alice uses `s_B_j` as the NUT-11 witness signatures and submits a swap request to the mint:

```http
POST /v1/swap
```

```json
{
  "inputs": [<Bob's sat proofs with witness s_B_j>],
  "outputs": [<Alice's blinded messages for fresh tokens>]
}
```

The mint verifies the P2PK signatures and processes the swap. Alice now holds fresh sat tokens.

### Step 8: Bob Extracts Adaptor Secret

Bob queries the mint's NUT-07 token state check endpoint for his spent sat proofs. Bob retains the proofs he constructed in step 6, so he can compute `Y_j = hash_to_curve(secret_j)` for each proof locally (see [NUT-00][nut-00] for `hash_to_curve`):

```http
POST /v1/checkstate
```

```json
{
  "Ys": [
    "<Y_j = hash_to_curve(secret_j) for each sat proof Bob locked to Alice>"
  ]
}
```

The mint returns the witness data including the valid Schnorr signatures `s_B_j` that Alice used:

```json
{
  "states": [
    {
      "Y": "...",
      "state": "SPENT",
      "witness": "{\"signatures\": [\"<s_B_j>\"]}"
    }
  ]
}
```

Bob extracts the adaptor secret from any signature pair:

```
t = Extract(s_B_j, s'_B_j) = s_B_j - s'_B_j
```

### Step 9: Bob Claims (Adapt + Swap)

With `t` recovered, Bob adapts Alice's pre-signatures into valid Schnorr signatures:

```
For each of Alice's proofs:
  s_A_i = Adapt(s'_A_i, t) = s'_A_i + t
```

Bob submits a swap request for Alice's YES proofs:

```http
POST /v1/swap
```

```json
{
  "inputs": [<Alice's YES proofs with witness s_A_i>],
  "outputs": [<Bob's blinded messages for fresh conditional tokens>]
}
```

The mint verifies and processes the swap. Bob now holds fresh YES conditional tokens.

## Market Close and Position Claim

The trading swap above moves conditional tokens between users while the market
is open. After the oracle resolves the market, winning conditional tokens are
redeemed through the mint, not through the matching engine.

1. A signed DLC oracle attestation closes the market. Relay publication is
   optional; a user may submit the signed attestation directly to the engine.
2. The engine verifies the attestation against the market's registered oracle
   and stores the verified oracle witness as a cache for that condition.
3. Portfolio views classify local CTF proofs as Active or Closed by joining the
   wallet-visible proofs with the engine's market state and final outcome.
4. A winning position claim sends the local CTF proofs plus the oracle witness
   to the mint's `POST /v1/redeem_outcome` endpoint. The mint verifies the
   witness and returns regular ecash proofs. Losing outcome proofs redeem to
   zero and remain closed.

For categorical markets, a held outcome collection wins when it contains the
attested outcome. For example, if the outcomes are `A`, `B`, `C` and the oracle
attests `B`, then `B` and `B|C` are winning collections while `A` and `A|C` are
losing collections.

The engine's cached witness is not a payout authority. A buggy or malicious
engine response cannot make losing tokens redeemable because the mint verifies
the oracle signature and condition keyset again during `redeem_outcome`.

## Security Analysis

### Atomicity

Atomicity requires **both** ingredients — adaptor signatures alone are not sufficient. The adaptor signature replaces HTLC's hash preimage with an EC scalar; the NUT-11 `locktime` + `refund` tags still provide the safety fallback when a counterparty disappears. Removing either piece breaks the protocol:

- Adaptor signatures guarantee that **if Alice spends, Bob can spend** (liveness / linkability).
- Locktime refunds guarantee that **if Alice never spends, Bob recovers his funds** (safety).

Given both, the three cases are:

- **If Alice claims** (step 7): Her adapted signatures `s_B = s'_B + t` are published to the mint. Bob can retrieve them via NUT-07 and extract `t`, which lets him claim Alice's proofs. Both parties complete the swap.
- **If Alice does not claim**: Neither party's tokens are spent. After each proof's locktime expires, both parties reclaim their own tokens via the refund path.
- **Bob cannot claim first**: Bob does not know `t`, so he cannot adapt Alice's pre-signatures. He must wait for Alice to reveal `t` by spending.

### Locktime Constraints

The locktime must be chosen carefully:

- **Too short**: Bob may not have time to query NUT-07 and submit his swap before Alice's refund window opens, creating a race condition.
- **Too long**: Tokens are locked for an extended period if the counterparty disappears.

Since this protocol involves only ecash swaps (no Lightning routing delays), locktimes can be very short — on the order of seconds rather than minutes. Both parties should agree on the locktime during the order matching phase.

**Important — locktime ordering**: Alice's YES proof locktime (`T_YES`) MUST be later than Bob's sat proof locktime (`T_sat`):

```
T_YES  >  T_sat  +  Δ
```

where `Δ` is the time Bob needs to query NUT-07, extract `t`, and submit his own swap.

Alice spends Bob's sat proofs first (step 7) and may wait until just before `T_sat` to do so. Bob must observe the spend, extract `t`, and spend Alice's YES proofs before `T_YES` expires. If the ordering were reversed (i.e. `T_YES < T_sat`), Alice could wait for her own YES refund window to open, refund her YES proofs, and still claim Bob's sats while `T_sat` is unexpired — stealing both sides of the trade. This is the core P03 (atomic-swap atomicity) invariant; implementations MUST validate the ordering before accepting a counterparty's pre-signatures.

### NUT-07 Dependency

This protocol requires the mint to support NUT-07 witness retrieval. This introduces several considerations:

- **Availability**: If the mint goes offline between steps 7 and 8, Bob cannot retrieve the witness. The locktime refund protects Bob's original sat proofs, but he loses the opportunity to claim the YES proofs.
- **Privacy**: Querying NUT-07 reveals to the mint that Bob is interested in specific spent proofs, which could help the mint correlate trading parties.
- **Censorship**: A malicious mint could refuse to return witness data, preventing Bob from extracting `t`. The locktime refund protects Bob's funds but breaks atomicity.
- **Race condition**: There is a window between Alice spending (step 7) and Bob querying (step 8) during which the mint could potentially go offline or become unresponsive.

These limitations are inherent to the P2PK + NUT-07 approach. For stronger atomicity guarantees, consider the atomic settlement endpoint variant (see [Alternatives](#comparison-with-htlc-approach)).

### Trust Model

| Entity              | Trust requirement                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Matching engine** | Non-custodial. Relays encrypted messages. Cannot decrypt (ECDH). Cannot steal funds. Can deny service (refuse to relay). |
| **Mint**            | Must honestly execute P2PK conditions and return NUT-07 witness data. Already trusted for token issuance.                |
| **Counterparty**    | Trustless. Cannot steal — can only grief by not completing (locktime refund protects).                                   |

## Comparison with HTLC Approach

NUT-14 defines Hash Time-Locked Contracts (HTLCs) for Cashu. While HTLCs can theoretically enable atomic swaps, they have significant disadvantages for conditional token trading:

| Property                     | HTLC (NUT-14)                                              | Adaptor Signatures (this protocol)                 |
| ---------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| **Lock type**                | Hash preimage `H(x)`                                       | EC point `T = t·G`                                 |
| **Preimage propagation**     | Requires NUT-07 (same dependency)                          | Requires NUT-07 (same dependency)                  |
| **Mint learns**              | The preimage value (can correlate both swap legs)          | Normal P2PK signatures (cannot link the two swaps) |
| **Privacy**                  | Same hash `H(x)` appears in both legs — trivially linkable | Different signatures, no on-chain linkage          |
| **Additional NUT required**  | NUT-14 (HTLC support)                                      | None beyond NUT-11 (P2PK)                          |
| **Cryptographic complexity** | Lower (hash + preimage)                                    | Higher (adaptor sig math)                          |

The privacy advantage is the key differentiator. With HTLCs, the mint sees the same hash lock on both swap legs and can trivially determine they are part of the same trade. With adaptor signatures, the mint sees two independent P2PK spends with unrelated signatures.

## Known Limitations and Mitigations

### Token Denomination Granularity

Cashu uses integer sat amounts and power-of-2 proof denominations. The first
bitCaster release requires limit-order face amounts to be divisible by 100 sats,
so every integer-cent price maps to an exact quote payment. For example, 1,000
face sats at price 37 maps to 370 quote sats. Implementations should reject
orders that would require fractional quote sats instead of silently rounding.

### Front-Running

The matching engine sees order flow and could trade ahead of users. Mitigation: use frequent batch auctions where all orders within a time window are matched at a single clearing price, eliminating the front-running advantage.

### DoS via Order Spam

An attacker can place orders, get matched, and never complete — locking the counterparty's tokens until the locktime expires. Mitigations:

- Short locktimes and engine-owned settlement timeout reminders. A timed-out
  reservation is released and the consumed orders are cancelled rather than
  silently returned to the book with reused ephemeral keys.
- Reputation tracking by the matching engine
- Small anti-spam deposits (e.g., Lightning invoice payment to the engine)

### Partial Fills

This protocol requires each matched pair to fully fill. Partial fills require splitting into multiple atomic swaps. A mint-operated order book could handle partial fills more naturally and may complement this protocol.

### Liquidity Fragmentation

Conditional tokens from different mints are not fungible. Trading is limited to tokens from the same mint.

## Prior Art

- [sig4sats](https://github.com/vstabile/sig4sats-script) — Working Cashu adaptor signature swap implementation
- [NIP-455 (draft)](https://github.com/vstabile/nips/blob/atomic-signature-swaps/XX.md) — Atomic signature swaps protocol for Nostr
- [Conduition ecash-DLC](https://github.com/cashubtc/nuts/pull/128) — Adaptor signatures for Cashu bets (closed PR)
- [Partially Blind Atomic Swap](https://github.com/ElementsProject/scriptless-scripts/blob/master/md/partially-blind-swap.md) — Blind Schnorr + adaptor signatures (Blockstream)
- [Scriptless Scripts](https://github.com/BlockstreamResearch/scriptless-scripts/blob/master/md/atomic-swap.md) — Original adaptor signature specification (Poelstra)
- [Blind Adaptor Signatures, Revisited](https://eprint.iacr.org/2026/060) — Formal BAS primitive (requires Schnorr, not BDHKE)

[nut-00]: https://github.com/cashubtc/nuts/blob/main/00.md
