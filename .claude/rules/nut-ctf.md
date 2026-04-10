---
paths:
  - "nuts/**/*"
  - "cdk/**/*"
---

# NUT-CTF Protocol

bitCaster uses **Conditional Timed Fungible (CTF) tokens** — Cashu proofs whose keysets are bound to a 32-byte `condition_id` that the mint derives from a DLC oracle announcement.

- `nuts/CTF.md` — core CTF protocol
- `nuts/CTF-split-merge.md` — split/merge for CTF proofs
- `nuts/CTF-numeric.md` — numeric outcome markets
- DLC oracle Nostr event kind: **88**

## CDK Submodule Policy

`cdk/` is an **upstream** Cashu Development Kit. Never add bitCaster-specific logic to CDK — it must only implement what the NUT specifications in `nuts/` define. bitCaster-specific tooling (seed scripts, test helpers, etc.) belongs in `tools/` or the top-level repo, not inside `cdk/`.
