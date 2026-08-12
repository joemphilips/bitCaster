import { assertNever } from "@/lib/enumDiscipline";
import type { components } from "@/generated/api";

/**
 * Engine-side `MarketState` enum, generated from the OpenAPI spec
 * (`MarketCatalogueEntry.state`). Source-of-truth split per ADR-009
 * (Amendment 2026-05-04 — detail-page compliance):
 *
 *  - lifecycle (Open / Closed) — engine `state`
 *  - market existence            — mintd `/v1/conditions`
 *  - outcome metadata            — mintd `attestation.*` (normalised at
 *                                   ingress via `lib/mintdIngress.ts`)
 *
 * Before this change the hook derived lifecycle from mintd's attestation
 * status with a negative comparison (`status !== 'pending'`), which silently
 * flipped to "Closed" for a freshly-created market with no attestation yet
 * (the P7 §`/markets/{id}` regression). The fix is structural: read engine
 * state directly, exhaustive-switch over the generated union, fail loudly on
 * any unexpected value via `assertNever`. See
 * `.claude/skills/bitcaster-coding-guideline/SKILL.md` for the full rule.
 */
export type MarketState = components["schemas"]["MarketCatalogueEntry"]["state"];

export type DerivedMarketState = "Open" | "Closed";

/**
 * Derive the rendered "Open" / "Closed" badge from the engine's authoritative
 * `MarketCatalogueEntry.state`. `null` / `undefined` is the pre-fetch state
 * (the engine catalogue request is in flight); render as Open so the trade
 * pane and bookmark affordances do not flash hidden during initial load.
 */
export function useMarketState(state: MarketState | null | undefined): DerivedMarketState {
  if (state == null) return "Open";
  switch (state) {
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    default:
      return assertNever(state);
  }
}
