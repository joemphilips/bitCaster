import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserMenu } from "../UserMenu";

describe("UserMenu balance display", () => {
  it.each([
    [7_000, "7 sats"],
    [7_001, "7.001 sats"],
  ])("shows %s msat as the exact sats balance", (balance, expected) => {
    render(<UserMenu user={{ name: "Anon", balance }} />);

    expect(screen.getByRole("group", { name: expected })).toHaveTextContent(expected);
    expect(screen.queryByText("₿7.0K")).not.toBeInTheDocument();
  });
});
