# Frontend E2E Test Guidance

Write E2E tests around user or protocol scenarios, not individual assertions.
A single browser/daemon scenario may assert every externally visible invariant
needed to prove the flow: UI state, API payloads, wallet persistence, reload
recovery, and final balances/proofs.

Prefer one E2E scenario over several near-identical tests that rerun the same
expensive setup only to check one extra field. Use component, unit, or API-level
tests for one-assertion checks and narrow rendering branches.

When adding or reviewing E2E coverage:

- Name tests after the scenario and matrix dimensions, not one assertion inside
  the scenario. Example: `ComplementaryBuySettlement_Matrix`.
- Keep browser/CLI/client matrices parameterized when they share the same flow.
- Add assertions to an existing scenario when the setup and user/protocol path
  are the same.
- Split into a new test only when the scenario has a meaningfully different
  setup, actor model, failure mode, persistence boundary, or user-visible path.
- Avoid preserving obsolete strategy assumptions in E2E gates. If a product
  behavior changes, update or retire the scenario instead of patching stale
  expectations until they pass.

## Running and cleaning up local diagnostics

Keep xUnit `showLiveOutput` enabled for local E2E runs. It streams progress to
stdout and does not create growing log files by itself.

Run local E2E with `--blame-hang` and a bounded `--blame-hang-timeout` so a
stalled test names the active test and terminates instead of hanging forever.
When blame-hang actually fires, VSTest may leave sequence files, dumps, or
other diagnostics under `TestResults/`. Inspect those artifacts immediately,
then delete the run-specific `TestResults/` contents once the failure has been
captured in an issue, review note, or commit message. Do not let old hang
artifacts accumulate across repeated local E2E runs.
