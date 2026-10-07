---
name: bitcaster-frontend-guideline
description: Apply bitCaster browser state, durable error, and recovery UX rules when those behaviors change.
---

# bitCaster Frontend Guideline

## State And Messages

- Show the authoritative state. Do not infer success or failure from a timeout.
- Distinguish an order failure from a funds failure.
- If a funds operation has an uncertain result, show that recovery is in progress.
- Recreate a durable error or recovery message after a reload from the durable operation state.
- Do not use a transient toast as the only record of a durable failure.
- Identify a durable message by operation ID, operation state version, and a bounded error code.

## Error Dismissal

- Do not set an automatic timeout for an error message.
- Remove an error message only after an explicit user action.
- Persist the acknowledgement for the exact durable message identity.
- Keep the same acknowledged message dismissed after reload.
- A later state version or error code can create a new message.
- Provide a visible and keyboard-accessible close button.
- Do not remove an unresolved error when a message queue reaches its limit.
- Store unresolved errors in bounded pages. Use a bounded visible viewport.
- Keep error text selectable and copyable.
- Do not include secrets, proofs, tokens, keys, or private protocol artifacts in an error.
- Success and information messages can use a bounded automatic timeout.

## Order And Recovery Messages

- If mint preparation does not return a verified capability, state that the order was not submitted.
- Do not retry that order automatically.
- Explain that the wallet will recover reserved funds when the mint is available.
- Do not submit a recovered capability for the failed order.
- Require a new user action and a new order-book observation for a new order attempt.

## Tests

Apply these checks to the changed behavior. Reuse valid evidence for unchanged
paths; do not run every listed scenario for a presentation-only edit.

- Mock network calls in `bitCaster-app` unit tests.
- Test that errors do not expire.
- Test explicit dismissal.
- Test queue-pressure behavior.
- Test reload reconstruction for durable failures.
- Test the difference between order failure and funds recovery.
- Add a parent E2E scenario for a user-visible real-stack failure when the change affects the complete flow.

### Keep Mocked And E2E Tests Aligned

- When frontend behavior or a mocked test expectation changes, inspect the corresponding frontend E2E scenario and its helpers.
- Update affected E2E actions, selectors, and expected results in the same change.
- Preserve the user-visible result. Do not weaken an assertion to hide a failure.
- If no E2E change is needed, name the inspected scenario and give a short reason in the implementation handoff.
- If no counterpart exists, state whether a real-stack scenario is needed. Do not add E2E coverage only for styling or copy.
- Run focused frontend E2E cases when interaction, request mapping, signing, persistence, or subscriptions change.
- Use component tests for presentation-only changes. Reserve the complete E2E suite for the workflow's final gate.
- Report which tests ran. Do not claim that an unrun E2E case passed.
