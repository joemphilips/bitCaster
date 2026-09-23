---
name: bitcaster-doc-sync
description: Keep bitCaster public documentation aligned with approved user-visible behavior.
allowed-tools: Bash(git diff *), Bash(git log *), Bash(gh pr diff *), Read, Glob, Grep, Write, Edit
---

# bitCaster Public Doc Sync

Use paths relative to the public repository.
Update `bitCaster-doc/` for a change to user-visible behavior or a public
technical contract. Skip internal changes that preserve public behavior.

## Authority And Scope

Faithfully record an already-approved behavior or decision without another
wording approval. Ask before introducing new behavior, a new product choice,
or a new accepted risk.

Keep English and Japanese docs in sync.
If the user limits the scope to one language, report the sync as incomplete
and stop. Do not claim parity or write a partial sync.
Do not mirror private plans, runbooks, or implementation details.
Do not cite or name private ADRs. Explain only the user-relevant rationale.

This skill does not grant commit, push, deploy, or submodule-publication
permission. Follow a separately authorized publication workflow when it applies.
Do not change index state while discovering documentation work.

## Find And Update The Pages

Select the diff named by the task.
Use `git diff HEAD` for tracked local changes.
Inspect relevant untracked files with the available file tools.
Use the requested PR, commit range, or time window when one is supplied.
Do not assume that the default branch is named `main`.

Read `.claude/rules/doc-site.md` for doc-site style.
Map each changed public behavior to the affected English page under
`bitCaster-doc/src/content/docs/` and its `ja/` mirror.
Search existing pages when the mapping is unclear.

| Changed behavior | Candidate pages relative to the English content root |
| --- | --- |
| Authentication | `technical/protocol/authentication.md` |
| Orders and settlement | `technical/architecture/trading-model.md`, `technical/protocol/atomic-swap.md` |
| Bot liquidity and funding | `technical/architecture/market-making.md`, `user-guide/core-concepts/funding-bot-liquidity.md` |
| Catalogue and market identity | `technical/protocol/market-catalogue.md` |
| Resolution and attestations | `user-guide/core-concepts/resolution.md` |
| Wallet setup and recovery | `user-guide/getting-started/overview.md`, `user-guide/getting-started/wallet-backup.md` |
| New public API or SignalR behavior | `technical/index.md` and the relevant protocol page |

Draft both language changes together.
Create a missing translation as part of the sync.
Keep technical claims equivalent across both languages.
Preserve exact protocol terms and wire values.
Apply the authority rule above before writing.
If either language update fails, stop and report the incomplete sync.

Report changed paths and any unresolved documentation issue.
Do not patch product code through this skill.
A separate authorized workflow owns publication and submodule metadata.
Remove only temporary artifacts created by this task.
