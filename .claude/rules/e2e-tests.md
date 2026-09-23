---
paths:
  - "bitCaster-app/src/**/*.browser.test.ts"
---

# Browser And Full-Stack Tests

This public repository has frontend unit tests and browser-runtime tests.
It does not contain the former `tests/E2E/` xUnit project.
Do not use that removed path as a verification command.

## Select The Check

Run commands from `bitCaster-app/`.

- Use `npm run test -- <test-file>` for a focused frontend unit test.
- Use `npm run test:nut16-browser` for the configured browser-runtime suite.
- Read `vitest.browser.config.ts` before adding a browser-runtime test.
- Use `playwright-cli` for an authorized live UI inspection.

Browser-runtime tests are not proof of full-stack settlement behavior.
Use the embedding repository's integration harness when the approved task
requires its real services. Keep that test-only integration separate from
this repository's standalone production code, build, and package dependencies.

## Local Service Ownership

Read `docker-compose.yml` before starting its services.
The Compose stack does not start a matching engine or the frontend.
Read `bitCaster-app/vite.config.ts` for the frontend port and proxy targets.
Use the endpoints supplied by the active harness for integration checks.

`tools/worktree-services.sh --slot N` starts only a Vite server.
It uses port `5273 + N * 100`.
It does not allocate a matching engine, isolate backend data, or export
variables to the calling shell.
Separate frontend ports do not make shared backend fixtures independent.

Use only authorized disposable test state.
Coordinate shared services before running tests that mutate them.
Stop only processes and containers owned by the current test run.
Do not infer staging access or deployment permission from a test task.

## Browser Fixtures And Evidence

- Use accessibility locators scoped to the intended visible component.
- Avoid hidden mobile or desktop copies when selecting controls.
- Wait for persisted-state hydration before checking restored state.
- Prevent startup effects from overwriting seeded test state.
- Install the test identity before an authenticated order action.
- Keep test identities and funds separate from real user state.
- Open an existing IndexedDB database without forcing an older version.
- Capture relevant console errors, network failures, and screenshots.
- Keep proof secrets, tokens, and private keys out of captured evidence.
