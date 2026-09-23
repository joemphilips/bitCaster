import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepIndicator } from "../StepIndicator";

describe("StepIndicator", () => {
  it("shows three steps for binary markets and maps review to step three", () => {
    render(<StepIndicator currentStep={3} outcomeType="yesno" />);

    expect(screen.getByText("Get Started")).toBeInTheDocument();
    expect(screen.getByText("Basic Info")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.queryByText("Outcomes")).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("keeps the outcomes step for categorical markets", () => {
    render(<StepIndicator currentStep={3} outcomeType="categorical" />);

    expect(screen.getByText("Outcomes")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });
});
