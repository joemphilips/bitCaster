# NUT-CTF Range v1 conformance vectors

These fixtures freeze bitCaster's reviewed draft dialect:

- cashubtc/nuts PR 412 at
  `dc5cfd5339cbbf9d257cd77ae3e95d1e9635cddc`;
- cashubtc/nuts PR 410 at
  `9b23df875e060870c1726ef61b4417fb4ee1878b`.

They cover standard and pool participants, endpoint-specific commitments,
canonical bitmaps, rational buy/sell limits, change and better-price selection,
fixed fragmented-input fees, mixed-mode 1-vs-N settlement, expiry, request
digest sensitivity, NUT-07/NUT-09 recovery inputs, exact-class refund digests,
mint and restore responses, rotated exact-class refund witnesses, mint-info
bounds, threshold/tie fee allocation, omitted-parent equivalence, full-fill
zero-change selection, recovery classification, identical retry, and invalid
cases.

The generator uses Node cryptographic built-ins and fixed source data, with
Prettier used only for the committed JSON layout. It does not import production
SDK, cashu-ts, or CDK code. Canonical inputs and intermediate bytes are retained
in `vectors.json` so another implementation can reproduce every digest
independently.

All mint keys, refund keys, proof secrets, and blinding factors are synthetic,
publicly derivable test material. Never use them with funded infrastructure.

Two byte-level choices that are terse in the draft prose are frozen explicitly:

1. `condition_id` and canonical `parent_collection_id` are decoded from
   lowercase hex into fixed 32-byte values before request-digest concatenation.
2. A pool participant canonicalizes as one complete JCS object. Its inputs are
   sorted by `(id, secret)`; outputs and manifest entries retain declared order;
   the selection bitmap is lowercase canonical hex.

Cashu `Proof.amount` and `BlindedMessage.amount` remain JSON numbers on the
wire, but their participant-canonical forms use decimal strings. `PoolEntry`
`amount` and `index` are decimal strings both on the wire and canonically.

`invalid_wire_vectors` contains complete replayable request bodies.
`invalid_cases` is the broader mutation catalogue; entries whose `mutation`
field is prose are test-design requirements rather than standalone wire bodies.

Generate or verify:

```bash
npm run vectors:nut-ctf-range:generate
npm run vectors:nut-ctf-range:check
```

The sample mint-info limits are fixture bounds, not production sizing claims.
Engine and mint deployment limits must be measured and versioned separately.
