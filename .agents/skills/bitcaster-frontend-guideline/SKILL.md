---
name: bitcaster-frontend-guideline
description: Apply bitCaster GUI layout, interface copy, form limit, browser state, durable error, and recovery UX rules when those behaviors change.
---

# bitCaster Frontend Guideline

## Interface Copy

- Avoid unnecessary secondary labels and explanations.
- Use layout, grouping, and visual hierarchy to make the interface clear without extra text.
- Use concise GUI text that states the action the user must take.
- Use precise CLI output that supports diagnosis.
- Keep required recovery actions and material funds warnings in both interfaces.
- Do not show relay delivery counts for a routine successful profile save.
- Japanese UI copy uses マーケット for a market, never 市場.
- The action that claims a winning position is 換金する / Cash out, the same
  verb as its notification.
- Quote a market title in running text (“{market}”, 「{market}」), because
  most titles end in a question mark.
- Keep every interface string in the locale files, in English and Japanese.

## Form Limits

- Do not show permanent helper text or a counter that states a limit.
- Show a limit only in an error next to the field.
- Show the error only while the input breaks the rule.
- Do not cut the input at a limit. Keep the input and show the error.
- Show an error for a value above a maximum immediately.
- Show an error for a value below a minimum, or for an incomplete value, when the user leaves the field.
- Do not show an error on an empty field that the user did not change.
- Remove the error immediately when the input obeys the rule.
- Disable the submit action while the input breaks a rule.
- Set `aria-invalid` on the field.
- Give the error `role="alert"`. Link it to the field with `aria-describedby`.
- For a file input, link the error to the visible control that opens the file chooser.
- Show one error for each field. When the input breaks more than one rule, show the most important rule.
- A field error is not a durable message. It does not need a close button.
- Use the validation rules and limit constants of the SDK.

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
- Exception: resolve the CTF range order alerts `recovery-pending`,
  `mint-source-uncertain`, and `order-submission-uncertain` when the durable
  order journal becomes terminal. The terminal journal makes their statement
  false. Mark them acknowledged and keep the row. Keep alerts with a definitive
  outcome until the user dismisses them.
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
