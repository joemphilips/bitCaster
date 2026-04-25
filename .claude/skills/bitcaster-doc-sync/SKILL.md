---
name: bitcaster-doc-sync
description: Sync bitCaster/bitCaster-doc with user-facing changes from the session's diff. Runs as step 3 of the Session Wrap-up. Enforces i18n parity (English ↔ Japanese) and keeps the doc site free of ADR references. Also invokable mid-session by architect/engineer when a change touches protocol, auth, order lifecycle, CPMM, or REST/SignalR shape.
argument-hint: "[pr-number | commit-sha | duration | nothing-for-local-or-branch]"
allowed-tools: Bash(git diff *), Bash(git log *), Bash(gh pr diff *), Read, Glob, Grep, Write, Edit
---

# bitCaster Doc Sync

Keep `bitCaster/bitCaster-doc/` in step with user-visible engine changes. Detects whether the session's diff changes a user-facing surface, maps paths to doc pages, and proposes diffs for approval.

## Hard rules

1. **Internal `docs/` is out of scope.** Never mirror anything under the outer repo's `docs/` (ADRs, runbooks, plans) to the doc site.
2. **i18n is blocking.** Every sync must land in both `src/content/docs/` and `src/content/docs/ja/`. If the user refuses the Japanese update, the sync aborts — no partial success, no TODO placeholder.
3. **No ADR references.** A page may be *informed* by an ADR but must never link to, cite, or name ADRs. Paraphrase the user-relevant rationale; strip the decision-log framing.
4. **No submodule bump.** Stop after writing files inside `bitCaster/`. The human stages the submodule commit and decides when to bump.
5. **Proposal-first.** Present diffs and wait for approval before writing.

## Workflow

1. **Pick the diff.** PR → `gh pr diff <n>`; commit SHA → `git diff <sha>..HEAD`; duration → since-oldest-commit; no arg + dirty → `git diff HEAD` (run `git ls-files --others --exclude-standard | xargs -r git add -N` first so new files show up); no arg + clean → `git diff main...HEAD`.

2. **Classify each changed path** using the mapping table below. If every path is in the Skip bucket, emit `Docs sync: no user-facing changes detected.` and exit. Do not prompt.

3. **Verify the `ja/` mirror exists** for each candidate English page. If missing, create it as part of the proposal — don't skip.

4. **Draft English + Japanese diffs together** for each candidate page. Read `bitCaster/.claude/rules/doc-site.md` first for style rules. Prose over bullets; match neighbor pages' voice; present tense; no ADR references; no session/phase framing ("recently added", "Phase 3"). Japanese reads natively but every technical claim in English must appear in Japanese — keep English terms in backticks when no natural translation exists.

5. **Await approval.**
   - Approve → proceed to step 6.
   - Edit request → revise and re-present.
   - "Skip Japanese" / "English only" → ABORT: emit `Docs sync aborted: Japanese mirror declined. English NOT written. Re-run when ready to complete both languages.` Exit without writing.
   - Defer → emit `Docs sync deferred.` and exit.

6. **Write** with `Edit` / `Write`, English and Japanese as one unit. If either fails, stop and report — never leave the languages out of sync. Do not `git add` or `git commit` the submodule.

7. **Report** the updated paths and remind the user that staging + submodule pointer bump is their step.

## Path → doc mapping

**Triggers a sync:**

| Source change | Candidate doc pages (English; `ja/` mirror required) |
|---|---|
| `BitCaster.MatchingEngine.Contracts/specs/**` | matching `technical/protocol/` page |
| `ApiService/Auth/**`, `Nip98AuthenticationHandler.cs`, auth Contracts | `technical/protocol/authentication.md` |
| `Domain/Aggregates/OrderBook/**`, order types (GTC/GTD/FOK/FAK) | `technical/architecture/market-making.md` (+ `user-guide/core-concepts/creating-markets.md` if user-observable) |
| `Domain/Aggregates/CpmmPool/**`, CPMM bootstrap/settlement | `technical/architecture/market-making.md` |
| Atomic-swap code (adaptor sigs, ECDH, NUT-11 P2PK) | `technical/protocol/atomic-swap.md` + `user-guide/core-concepts/atomic-swap.md` |
| Resolution / settlement / oracle attestation | `user-guide/core-concepts/resolution.md` |
| New/renamed REST endpoints, SignalR methods, DTO shape the frontend sees | `technical/index.md` + most-specific protocol page |
| Market-ID format, fee model, deposit model | `user-guide/core-concepts/creating-markets.md` + `technical/architecture/market-making.md` |
| Frontend flows that change the user's mental model (wallet, market creation) | `user-guide/getting-started/overview.md` + affected `core-concepts/*` |

**Skips (internal):** outer repo `docs/**` · `*.Unit/**` · `*.E2E/**` · `infrastructure/**` · `.github/workflows/**` · `AppHost/**` · `ServiceDefaults/**` · `.claude/**` · `scripts/**` · pure refactors that preserve external contracts · Sekiban plumbing with no external behavior change.

## Rules

- Never edit outside `bitCaster/bitCaster-doc/`. If the code itself looks wrong, surface it — do not patch code here.
- Clean up `/tmp/bitcaster-doc-sync-*.diff` at the end (`rm -f`).
