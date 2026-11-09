import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ReviewAndCreate } from "../ReviewAndCreate";
import type { WizardStepBasicInfo } from "@/types/market-creation";
import i18n from "@/i18n";

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
  it("renders the Japanese byte-limit error even below the character limit", async () => {
    try {
      await i18n.changeLanguage("ja");
      const description = "界".repeat(342);
      render(
        <MemoryRouter>
          <ReviewAndCreate
            description={description}
            basicInfo={basicInfo}
            outcomes={null}
            isSubmitting={false}
            submitError={null}
          />
        </MemoryRouter>,
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveValue(description);
      expect(screen.getByText("342 / 1024 文字（1026 / 1024 UTF-8 バイト）")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "説明は 1024 文字・UTF-8 で 1024 バイト以内にしてください。",
      );
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription(/説明は 1024 文字/);
      expect(screen.getByRole("button", { name: "マーケットを作成" })).toBeDisabled();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("shows a missing description only after blur", () => {
    render(
      <MemoryRouter>
        <ReviewAndCreate
          description=""
          basicInfo={basicInfo}
          outcomes={null}
          isSubmitting={false}
          submitError={null}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(screen.getByRole("textbox"));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a market description.");
    expect(screen.getByRole("button", { name: "Create Market" })).toBeDisabled();
  });

  it("refuses combined metadata that exceeds the mint's bound", () => {
    render(
      <MemoryRouter>
        <ReviewAndCreate
          description="Valid description"
          basicInfo={{ ...basicInfo, categoryTags: ["x".repeat(4096)] }}
          outcomes={null}
          isSubmitting={false}
          submitError={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/remove categories/);
    expect(screen.getByRole("button", { name: "Create Market" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create Market" })).toHaveAccessibleDescription(
      /combined data/,
    );
  });

  it("shows live multilingual counts and blocks oversized descriptions without truncating", () => {
    const onDescriptionChange = vi.fn();
    const props = {
      basicInfo,
      outcomes: null,
      isSubmitting: false,
      submitError: null,
      onDescriptionChange,
    };
    const view = render(
      <MemoryRouter>
        <ReviewAndCreate {...props} description={"界".repeat(310)} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/310\s*\/\s*1,?024/)).toHaveTextContent(/930\s*\/\s*1,?024/);
    expect(screen.getByRole("button", { name: "Create Market" })).toBeEnabled();
    const tooLong = "界".repeat(342);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: tooLong } });
    expect(onDescriptionChange).toHaveBeenCalledWith(tooLong);
    view.rerender(
      <MemoryRouter>
        <ReviewAndCreate {...props} description={tooLong} />
      </MemoryRouter>,
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue(tooLong);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/1,?024/);
    expect(input).toHaveAccessibleDescription(/1,?024/);
    expect(screen.getByRole("button", { name: "Create Market" })).toBeDisabled();
  });

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
