import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ReviewAndCreate } from "../ReviewAndCreate";
import { ResolutionInfo } from "@/components/market-detail/ResolutionInfo";
import type { WizardStepBasicInfo } from "@/types/market-creation";
import i18n from "@/i18n";
import { I18nextProvider } from "react-i18next";

vi.mock("@/lib/oracleAttestation", () => ({
  readBrowserResolutionExplanation: vi.fn(),
}));

const markdownCriteria = [
  "Resolves **Yes** if BTC closes above `100000` USD.",
  "",
  "- Source: [CoinGecko](https://www.coingecko.com)",
  "- ![Chart](https://example.com/chart.png)",
  "",
  "<script>alert(1)</script>",
].join("\n");

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
  it.each([
    ["en", "Write", "Preview", "Create Market"],
    ["ja", "編集", "プレビュー", "マーケットを作成"],
  ] as const)(
    "keeps raw-source limits visible and blocks creation in %s Preview",
    async (language, write, preview, create) => {
      const description = `**${"界".repeat(342)}**`;
      const onDescriptionChange = vi.fn();
      const onCreateMarket = vi.fn();
      const user = userEvent.setup();
      render(
        <I18nextProvider i18n={i18n.cloneInstance({ lng: language })}>
          <MemoryRouter>
            <ReviewAndCreate
              description={description}
              basicInfo={basicInfo}
              outcomes={null}
              isSubmitting={false}
              submitError={null}
              onDescriptionChange={onDescriptionChange}
              onCreateMarket={onCreateMarket}
            />
          </MemoryRouter>
        </I18nextProvider>,
      );
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("aria-invalid", "true");
      await user.click(screen.getByRole("tab", { name: preview }));
      expect(input).not.toBeVisible();
      expect(screen.getByText(/346 \/ 1024/)).toHaveTextContent(/1030 \/ 1024/);
      expect(screen.getByText(/346 \/ 1024/)).toBeVisible();
      expect(screen.getByRole("alert")).toBeVisible();
      expect(screen.getByRole("tabpanel")).toHaveAccessibleDescription(/1030 \/ 1024/);
      expect(screen.getByRole("button", { name: create })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: create }));
      expect(onCreateMarket).not.toHaveBeenCalled();
      await user.click(screen.getByRole("tab", { name: write }));
      expect(input).toBeVisible();
      expect(input).toHaveValue(description);
      expect(onDescriptionChange).not.toHaveBeenCalled();
    },
  );

  it("navigates editor tabs with arrow, Home, and End keys using one tab stop", async () => {
    review(null);
    const user = userEvent.setup();
    const write = screen.getByRole("tab", { name: "Write" });
    const preview = screen.getByRole("tab", { name: "Preview" });
    expect(screen.getByRole("tablist", { name: "Description" })).toBeVisible();
    expect(write).toHaveAttribute("tabindex", "0");
    expect(preview).toHaveAttribute("tabindex", "-1");
    write.focus();
    for (const [key, selected, other] of [
      ["{ArrowLeft}", preview, write],
      ["{ArrowRight}", write, preview],
      ["{End}", preview, write],
      ["{Home}", write, preview],
    ] as const) {
      await user.keyboard(key);
      expect(selected).toHaveFocus();
      expect(selected).toHaveAttribute("aria-selected", "true");
      expect(selected).toHaveAttribute("tabindex", "0");
      expect(other).toHaveAttribute("tabindex", "-1");
    }
    await user.tab();
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

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

  it("keeps the description value in Write and renders it in Preview", async () => {
    const user = userEvent.setup();
    const onDescriptionChange = vi.fn();
    render(
      <MemoryRouter>
        <ReviewAndCreate
          description={markdownCriteria}
          basicInfo={basicInfo}
          outcomes={null}
          isSubmitting={false}
          submitError={null}
          onDescriptionChange={onDescriptionChange}
        />
      </MemoryRouter>,
    );

    const write = screen.getByRole("tab", { name: "Write" });
    const preview = screen.getByRole("tab", { name: "Preview" });
    const textarea = screen.getByPlaceholderText(/Describe your market in detail/);
    expect(write).toHaveAttribute("aria-selected", "true");
    expect(textarea).toBeVisible();
    expect(textarea).toHaveValue(markdownCriteria);
    expect(screen.queryByTestId("market-markdown")).toBeNull();

    await user.click(preview);
    expect(preview).toHaveAttribute("aria-selected", "true");
    expect(textarea).not.toBeVisible();
    const rendered = screen.getByTestId("market-markdown");
    expect(rendered.querySelector("strong")).toHaveTextContent("Yes");
    expect(rendered.querySelector("script, img")).toBeNull();
    expect(screen.getByRole("link", { name: "CoinGecko" })).toHaveAttribute(
      "rel",
      "noopener noreferrer nofollow ugc",
    );

    await user.click(write);
    expect(screen.getByPlaceholderText(/Describe your market in detail/)).toHaveValue(
      markdownCriteria,
    );
    expect(onDescriptionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create Market" })).toBeEnabled();
  });

  it("previews the criteria exactly as the market detail shows them", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter>
        <ReviewAndCreate
          description={markdownCriteria}
          basicInfo={basicInfo}
          outcomes={null}
          isSubmitting={false}
          submitError={null}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    const previewHtml = screen.getByTestId("market-markdown").outerHTML;
    unmount();

    render(
      <ResolutionInfo
        resolution={{ criteria: markdownCriteria, source: "oracle", resolutionDate: null }}
      />,
    );
    expect(screen.getByTestId("market-markdown").outerHTML).toBe(previewHtml);
  });
});
