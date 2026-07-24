import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { FilterControls } from "../FilterControls";

describe("FilterControls", () => {
  it("returns null when isVisible is false", () => {
    const { container } = render(
      <FilterControls isVisible={false} selectedMarketTypes={[]} volumeRange={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders filter controls when visible", () => {
    render(<FilterControls isVisible={true} selectedMarketTypes={[]} volumeRange={{}} />);

    expect(screen.getByText("Filters:")).toBeInTheDocument();
    expect(screen.getByText("Yes/No")).toBeInTheDocument();
    expect(screen.getByText("Categorical")).toBeInTheDocument();
    expect(screen.queryByText("Two-Dimensional")).not.toBeInTheDocument();
  });

  it("calls onMarketTypeChange when a type is toggled", async () => {
    const user = userEvent.setup();
    const onMarketTypeChange = vi.fn();

    render(
      <FilterControls
        isVisible={true}
        selectedMarketTypes={[]}
        volumeRange={{}}
        onMarketTypeChange={onMarketTypeChange}
      />,
    );

    await user.click(screen.getByText("Yes/No"));
    expect(onMarketTypeChange).toHaveBeenCalledWith(["yesno"]);
  });

  it("shows Clear all button when filters are active and resets on click", async () => {
    const user = userEvent.setup();
    const onMarketTypeChange = vi.fn();
    const onVolumeRangeChange = vi.fn();
    const onClosingDateChange = vi.fn();
    const onIncludeClosedChange = vi.fn();

    render(
      <FilterControls
        isVisible={true}
        selectedMarketTypes={["yesno"]}
        volumeRange={{}}
        includeClosed={true}
        onMarketTypeChange={onMarketTypeChange}
        onVolumeRangeChange={onVolumeRangeChange}
        onClosingDateChange={onClosingDateChange}
        onIncludeClosedChange={onIncludeClosedChange}
      />,
    );

    const clearAll = screen.getByText("Clear all");
    expect(clearAll).toBeInTheDocument();

    await user.click(clearAll);
    expect(onMarketTypeChange).toHaveBeenCalledWith([]);
    expect(onVolumeRangeChange).toHaveBeenCalledWith({});
    expect(onClosingDateChange).toHaveBeenCalledWith(undefined);
    expect(onIncludeClosedChange).toHaveBeenCalledWith(false);
  });

  it("calls onIncludeClosedChange when the closed-market toggle changes", async () => {
    const user = userEvent.setup();
    const onIncludeClosedChange = vi.fn();

    render(
      <FilterControls
        isVisible={true}
        selectedMarketTypes={[]}
        volumeRange={{}}
        onIncludeClosedChange={onIncludeClosedChange}
      />,
    );

    await user.click(screen.getByLabelText("Include closed"));

    expect(onIncludeClosedChange).toHaveBeenCalledWith(true);
  });
});
