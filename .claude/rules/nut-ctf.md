---
paths:
  - "nuts/**/*"
  - "cdk/**/*"
---

# NUT-CTF Protocol

bitCaster uses Conditional Timed Fungible (CTF) tokens — Cashu proofs whose keysets are bound to a `condition_id` (32-byte hex derived by the mint from an oracle announcement).

Specs:
- `nuts/CTF.md` — core CTF protocol
- `nuts/CTF-split-merge.md` — split/merge operations for CTF proofs
- `nuts/CTF-numeric.md` — numeric outcome markets

DLC oracle event kind on Nostr: **88**

## CDK Submodule Policy

The `cdk/` submodule is an upstream Cashu Development Kit. **Never add bitCaster-specific logic to CDK.** CDK must only implement what is defined in the NUT specifications (`nuts/`). Any bitCaster-specific tooling (seed scripts, test helpers, etc.) belongs in `tools/` or the top-level repo, not inside `cdk/`.
