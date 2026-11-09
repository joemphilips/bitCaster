import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ReviewAndCreate } from "../ReviewAndCreate";
import { ResolutionInfo } from "@/components/market-detail/ResolutionInfo";
import type { WizardStepBasicInfo } from "@/types/market-creation";

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
