/**
 * Compile-time exhaustiveness guard for `switch` statements over discriminated
 * unions / generated enum types. The intent is documented in
 * `.claude/skills/bitcaster-coding-guideline/SKILL.md` (Rule 3): adding a new
 * variant to an OpenAPI-generated enum must produce a TypeScript compile
 * error at every consumer rather than silently picking up a runtime branch.
 *
 * Usage:
 *
 *   switch (state) {
 *     case 'open':   return 'Open'
 *     case 'closed': return 'Closed'
 *     default:       return assertNever(state)
 *   }
 *
 * If a `pending` variant is later added to the spec and regenerated into the
 * frontend's union, this call site fails to type-check — `pending` does not
 * widen to `never` — flagging the consumer as needing an update.
 *
 * The runtime throw is the safety belt: if a producer ever ships a value
 * outside the declared union (caused by a spec / generator mismatch, hand-
 * crafted JSON in tests, or a future variant landing in production before
 * the consumer is rebuilt), the call site fails loudly instead of silently
 * picking the "wrong" branch.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled enum variant: ${JSON.stringify(x)}`);
}
