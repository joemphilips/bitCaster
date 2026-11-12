import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { BasicInfo } from "../BasicInfo";
import type { WizardStepBasicInfo } from "@/types/market-creation";
import i18n from "@/i18n";
import { MAX_MARKET_CREATION_MATURITY_EPOCH } from "@bitcaster/client-sdk/marketCreationInput";

function futureDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 16);
}

function pastDate(): string {
  return "2020-01-01T00:00";
}

const defaultData: WizardStepBasicInfo = {
  imageFile: null,
  title: "",
  categoryTags: [],
  closingDate: "",
};

const categoryTags = ["politics", "sports", "crypto"];

describe("BasicInfo", () => {
  it("renders the Japanese title limit and preserves all pasted characters", async () => {
    try {
      await i18n.changeLanguage("ja");
      const title = "界".repeat(101);
      render(
        <BasicInfo
          data={{ ...defaultData, title, closingDate: futureDate() }}
          categoryTags={categoryTags}
        />,
      );
      const input = screen.getByRole("textbox", { name: "タイトル" });
      expect(input).toHaveValue(title);
      expect(screen.getByText("101 / 100 文字（303 / 400 UTF-8 バイト）")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "タイトルは 100 文字・UTF-8 で 400 バイト以内にしてください。",
      );
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription(/タイトルは 100 文字/);
      expect(screen.getByRole("button", { name: "次へ" })).toBeDisabled();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("accepts the exact U32 maturity maximum and rejects one second later", () => {
    const data = {
      ...defaultData,
      title: "Future market",
      closingDate: new Date(MAX_MARKET_CREATION_MATURITY_EPOCH * 1000).toISOString(),
    };
    const view = render(<BasicInfo data={data} categoryTags={categoryTags} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(
      <BasicInfo
        data={{
          ...data,
          closingDate: new Date((MAX_MARKET_CREATION_MATURITY_EPOCH + 1) * 1000).toISOString(),
        }}
        categoryTags={categoryTags}
      />,
    );
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an end time on or before");
  });

  it("reports incomplete Unicode without confusing it with a character limit", () => {
    render(
      <BasicInfo
        data={{ ...defaultData, title: "Question \ud800", closingDate: futureDate() }}
        categoryTags={categoryTags}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("incomplete characters in the title");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("shows a missing title only after blur and clears the error when corrected", () => {
    const view = render(<BasicInfo data={defaultData} categoryTags={categoryTags} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(screen.getByPlaceholderText("Type title..."));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a market title.");
    view.rerender(
      <BasicInfo data={{ ...defaultData, title: "日本語の質問" }} categoryTags={categoryTags} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type title...")).toHaveAttribute("aria-invalid", "false");
  });

  it("explains an end time beyond the oracle's supported range", () => {
    render(
      <BasicInfo
        data={{ ...defaultData, title: "Future market", closingDate: "2200-01-01T00:00" }}
        categoryTags={categoryTags}
      />,
    );
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an end time on or before");
    expect(screen.getByRole("button", { name: "End Time" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("button", { name: "End Time" })).toHaveAccessibleDescription(
      /Choose an end time/,
    );
  });

  it("counts Unicode characters and UTF-8 bytes and preserves an over-limit title", () => {
    const onTitleChange = vi.fn();
    const props = { categoryTags, onTitleChange };
    const data = { ...defaultData, title: "🌦".repeat(100), closingDate: futureDate() };
    const view = render(<BasicInfo {...props} data={data} />);
    expect(screen.getByText(/100\s*\/\s*100/)).toHaveTextContent(/400\s*\/\s*400/);
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();

    const tooLong = "🌦".repeat(101);
    fireEvent.change(screen.getByPlaceholderText("Type title..."), { target: { value: tooLong } });
    expect(onTitleChange).toHaveBeenCalledWith(tooLong);
    view.rerender(<BasicInfo {...props} data={{ ...data, title: tooLong }} />);
    const input = screen.getByPlaceholderText("Type title...");
    expect(input).toHaveValue(tooLong);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/100/);
    expect(input).toHaveAccessibleDescription(/100/);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("sends a dropped image through the same thumbnail callback", () => {
    const onThumbnailUpload = vi.fn();
    render(
      <BasicInfo
        data={defaultData}
        categoryTags={categoryTags}
        onThumbnailUpload={onThumbnailUpload}
      />,
    );
    const file = new File(["synthetic"], "thumbnail.png", { type: "image/png" });
    fireEvent.drop(screen.getByTestId("market-thumbnail-drop"), {
      dataTransfer: { files: [file] },
    });
    expect(onThumbnailUpload).toHaveBeenCalledWith(file);
  });

  it.each([{ thumbnailLocked: true }, { thumbnailPending: true }])(
    "ignores drops while thumbnail input is unavailable: %j",
    (state) => {
      const onThumbnailUpload = vi.fn();
      render(
        <BasicInfo
          data={defaultData}
          categoryTags={categoryTags}
          onThumbnailUpload={onThumbnailUpload}
          {...state}
        />,
      );
      fireEvent.drop(screen.getByTestId("market-thumbnail-drop"), {
        dataTransfer: { files: [new File(["synthetic"], "image.png")] },
      });
      expect(onThumbnailUpload).not.toHaveBeenCalled();
    },
  );

  it("disables Next when title and closing date are empty", () => {
    render(<BasicInfo data={defaultData} categoryTags={categoryTags} />);
    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(nextBtn).toBeDisabled();
  });

  it("disables Next when title is present but closing date is empty", () => {
    render(
      <BasicInfo data={{ ...defaultData, title: "Test Market" }} categoryTags={categoryTags} />,
    );
    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(nextBtn).toBeDisabled();
  });

  it("disables Next when closing date is in the past", () => {
    render(
      <BasicInfo
        data={{ ...defaultData, title: "Test Market", closingDate: pastDate() }}
        categoryTags={categoryTags}
      />,
    );
    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(nextBtn).toBeDisabled();
  });

  it("enables Next when title is present and closing date is in the future", () => {
    render(
      <BasicInfo
        data={{ ...defaultData, title: "Test Market", closingDate: futureDate() }}
        categoryTags={categoryTags}
      />,
    );
    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(nextBtn).toBeEnabled();
  });

  it("renders the End Time picker trigger with placeholder when unset", () => {
    render(<BasicInfo data={defaultData} categoryTags={categoryTags} />);
    const trigger = screen.getByRole("button", { name: "End Time" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent(/select date/i);
  });

  it("calls onTitleChange when title is typed", async () => {
    const user = userEvent.setup();
    const onTitleChange = vi.fn();
    render(
      <BasicInfo data={defaultData} categoryTags={categoryTags} onTitleChange={onTitleChange} />,
    );
    const titleInput = screen.getByPlaceholderText("Type title...");
    await user.type(titleInput, "A");
    expect(onTitleChange).toHaveBeenCalledWith("A");
  });

  it("calls onNext when Next is clicked with valid data", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <BasicInfo
        data={{ ...defaultData, title: "Test", closingDate: futureDate() }}
        categoryTags={categoryTags}
        onNext={onNext}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledOnce();
  });
});

describe("thumbnail retention controls", () => {
  it("blocks Next while retention is pending or failed and exposes explicit removal", async () => {
    const onRemove = vi.fn();
    const props = {
      data: { ...defaultData, title: "Test", closingDate: futureDate() },
      categoryTags,
      onThumbnailRemove: onRemove,
    };
    const view = render(<BasicInfo {...props} thumbnailPending />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();
    view.rerender(<BasicInfo {...props} thumbnailError="Image could not be retained" />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Image could not be retained");
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("shows a rejected file as a neutral notice without a selection to remove or a blocked Next", () => {
    const message = "Image not added. Choose a valid JPEG, PNG, or WebP image, up to 5 MiB.";
    render(
      <BasicInfo
        data={{ ...defaultData, title: "Test", closingDate: futureDate() }}
        categoryTags={categoryTags}
        onThumbnailRemove={vi.fn()}
        thumbnailRejectionNotice={message}
      />,
    );

    expect(screen.getByText("No image")).toBeInTheDocument();
    // The draft is valid without an image, so the notice is not an error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(message);
    expect(notice.className).not.toMatch(/text-red/);
    expect(screen.getByRole("button", { name: "Upload image" })).toHaveAccessibleDescription(
      message,
    );
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("states the image limit only in an error that describes the upload control", () => {
    const props = {
      data: { ...defaultData, title: "Test", closingDate: futureDate() },
      categoryTags,
    };
    const view = render(<BasicInfo {...props} />);
    const upload = screen.getByRole("button", { name: "Upload image" });
    expect(screen.queryByText(/MiB/)).not.toBeInTheDocument();
    expect(upload).not.toHaveAttribute("aria-describedby");

    const message = "Choose a valid JPEG, PNG, or WebP image, up to 5 MiB.";
    view.rerender(<BasicInfo {...props} thumbnailError={message} />);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(upload).toHaveAccessibleDescription(message);
  });
});
