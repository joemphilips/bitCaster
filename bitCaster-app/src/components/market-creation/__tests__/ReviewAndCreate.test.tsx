import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ReviewAndCreate } from "../ReviewAndCreate";
import type { WizardStepBasicInfo } from "@/types/market-creation";

const basicInfo: WizardStepBasicInfo = {
  imageFile: null,
  title: "Will it rain?",
  categoryTags: [],
  closingDate: "",
};

function review(imageFile: string | null) {
  return render(
    <MemoryRouter>
      <ReviewAndCreate
        description="Rain in Tokyo."
        basicInfo={{ ...basicInfo, imageFile }}
        outcomes={null}
        isSubmitting={false}
        submitError={null}
      />
    </MemoryRouter>,
  );
}

describe("ReviewAndCreate", () => {
  it("states that the market has no image before creation", () => {
    review(null);

    expect(screen.getByText("Thumbnail")).toBeInTheDocument();
    expect(screen.getByText("No image")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows the selected image before creation", () => {
    review("blob:selected-thumbnail");

    expect(screen.getByRole("img", { name: "Thumbnail" })).toHaveAttribute(
      "src",
      "blob:selected-thumbnail",
    );
    expect(screen.queryByText("No image")).not.toBeInTheDocument();
  });
});
