import { describe, expect, it } from "vitest";
import {
  deriveWinner,
  deriveWinnerStatus,
  isWinningCollection,
  parseOutcomeCollection,
} from "../positionWinner";

describe("parseOutcomeCollection", () => {
  it("splits a composite collection into legs", () => {
    expect(parseOutcomeCollection("A|B")).toEqual(["A", "B"]);
  });

  it("returns a single leg for a primitive collection", () => {
    expect(parseOutcomeCollection("A")).toEqual(["A"]);
  });

  it("honours escaped pipes in outcome names", () => {
    expect(parseOutcomeCollection("A\\|B|C")).toEqual(["A|B", "C"]);
  });
});

describe("isWinningCollection (per-keyset membership rule)", () => {
  it("treats a primitive collection containing the final outcome as winning", () => {
    expect(isWinningCollection("A", "A")).toBe(true);
  });

  it("treats a composite collection containing the final outcome as winning", () => {
    // The mint redeems a collection's proofs iff the collection contains the
    // attested outcome, so "A|B" with final "A" is a WINNING keyset.
    expect(isWinningCollection("A|B", "A")).toBe(true);
  });

  it("treats a collection NOT containing the final outcome as losing", () => {
    expect(isWinningCollection("B", "A")).toBe(false);
    expect(isWinningCollection("A|B", "C")).toBe(false);
  });

  it("is case-insensitive and trims", () => {
    expect(isWinningCollection("Alice", " alice ")).toBe(true);
  });

  it("is losing when no final outcome is attested", () => {
    expect(isWinningCollection("A", null)).toBe(false);
    expect(isWinningCollection("A", undefined)).toBe(false);
    expect(isWinningCollection("A", "")).toBe(false);
  });
});

describe("deriveWinner (P22 Link F single source-of-truth)", () => {
  // TEST 3: singular-A winner -> winner.
  it("marks a singular winning leg as a winner with full value", () => {
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: "A",
        legs: [{ outcomeCollection: "A", amount: 250 }],
      }),
    ).toEqual({ status: "winner", claimableValue: 250 });
  });

  it("is case-insensitive on the final outcome match", () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: "alice",
        legs: [{ outcomeCollection: "Alice", amount: 1 }],
      }),
    ).toBe("winner");
  });

  // TEST 1 (the core P22 Link F HIGH bug): an UNCLAIMED composite "A|B"
  // position holds BOTH a winning A leg AND a losing B leg, final outcome "A".
  // The OLD `.every` rule classified this a LOSER -> only a destructive Remove
  // offered -> the user destroys the winning A-keyset proofs. The CORRECT rule:
  // it holds >= 1 proof on a winning keyset -> WINNER, claimable, Claim offered,
  // Remove NOT offered. Value = the A (winning) leg only; the B leg is worth 0.
  it("marks an unclaimed composite holding winning + losing keysets as a WINNER (value = winning legs only)", () => {
    const result = deriveWinner({
      isClosed: true,
      finalOutcome: "A",
      legs: [
        { outcomeCollection: "A", amount: 100 },
        { outcomeCollection: "B", amount: 40 },
      ],
    });
    expect(result.status).toBe("winner");
    // B leg (losing) contributes 0; claimable value is the A leg amount only.
    expect(result.claimableValue).toBe(100);
  });

  it('treats a single composite-labelled "A|B" leg (composite-storage variant) as a WINNER', () => {
    // Some settlement paths persist fresh proofs under the composite label
    // "A|B" on a single keyset. The whole collection redeems if it contains the
    // attested outcome, so the full amount is claimable.
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: "A",
        legs: [{ outcomeCollection: "A|B", amount: 70 }],
      }),
    ).toEqual({ status: "winner", claimableValue: 70 });
  });

  // TEST 2: closed position holding ONLY losing legs -> LOSER.
  it("marks a closed position holding only losing legs as a loser with 0 value", () => {
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: "A",
        legs: [
          { outcomeCollection: "B", amount: 30 },
          { outcomeCollection: "C", amount: 20 },
        ],
      }),
    ).toEqual({ status: "loser", claimableValue: 0 });
  });

  it("marks a singular non-winning leg as a loser", () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: "A",
        legs: [{ outcomeCollection: "B", amount: 10 }],
      }),
    ).toBe("loser");
  });

  // TEST 4: after a claim removes all legs -> no legs -> not a winner -> no row.
  // (usePortfolioState only emits a Position when legs exist; the derivation
  // itself must not invent a winner from zero held proofs.)
  it("is a loser (never a winner) once all legs are removed by a successful claim", () => {
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: "A",
        legs: [],
      }),
    ).toEqual({ status: "loser", claimableValue: 0 });
  });

  it("treats an open market as active regardless of legs", () => {
    expect(
      deriveWinner({
        isClosed: false,
        finalOutcome: "A",
        legs: [{ outcomeCollection: "A", amount: 5 }],
      }),
    ).toEqual({ status: "active", claimableValue: 0 });
  });

  // P22 Link F regression guard: a CLOSED but NOT-YET-ATTESTED market (no final
  // outcome — closed by deadline, or in the window before the oracle attests)
  // must be PENDING, never a loser. A loser is offered the destructive Remove
  // (PortfolioPage gates Remove on isLoser); offering it here would let the user
  // PERMANENTLY DESTROY proofs whose win/loss is NOT YET DECIDED. Pending is
  // non-destructive (neither Claim nor Remove) and the value is NOT zeroed — the
  // outcome is undecided, not a loss, so claimableValue = the full held amount.
  it("treats a closed market with no attested outcome as PENDING (non-destructive), value = held amount, never a loser", () => {
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: undefined,
        legs: [{ outcomeCollection: "A", amount: 5 }],
      }),
    ).toEqual({ status: "pending", claimableValue: 5 });
  });

  it("treats a closed market with a null final outcome as PENDING, summing held legs", () => {
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: null,
        legs: [
          { outcomeCollection: "A", amount: 30 },
          { outcomeCollection: "B", amount: 20 },
        ],
      }),
    ).toEqual({ status: "pending", claimableValue: 50 });
  });

  it("treats a closed market with an empty/whitespace final outcome as PENDING, never a loser", () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: "   ",
        legs: [{ outcomeCollection: "A", amount: 5 }],
      }),
    ).toBe("pending");
  });

  it("treats an empty outcome collection leg as non-winning", () => {
    expect(
      deriveWinner({
        isClosed: true,
        finalOutcome: "A",
        legs: [{ outcomeCollection: "", amount: 5 }],
      }),
    ).toEqual({ status: "loser", claimableValue: 0 });
  });
});
