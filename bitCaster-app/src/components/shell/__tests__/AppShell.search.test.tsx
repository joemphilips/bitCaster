import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../AppShell";

vi.mock("../NotificationBell", () => ({ NotificationBell: () => null }));

afterEach(cleanup);

// The router commits each search URL after the keystroke that wrote it. A
// commit can arrive after the user has typed more characters. The test
// controls the URL value directly, so each commit order is explicit.
function renderShell(searchQuery: string, onSearchChange: (query: string) => void) {
  return (
    <AppShell
      navigationItems={[]}
      isLoggedIn={false}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
    >
      <p>Market</p>
    </AppShell>
  );
}

describe("AppShell search draft", () => {
  it("keeps newer typed characters when an older own URL value commits late", () => {
    const onSearchChange = vi.fn();
    const { rerender } = render(renderShell("", onSearchChange));
    const input = screen.getByPlaceholderText("Search markets...");

    fireEvent.change(input, { target: { value: "n" } });
    fireEvent.change(input, { target: { value: "no" } });
    expect(onSearchChange.mock.calls).toEqual([["n"], ["no"]]);

    rerender(renderShell("n", onSearchChange));
    expect(input).toHaveValue("no");

    fireEvent.change(input, { target: { value: "no " } });
    rerender(renderShell("no", onSearchChange));
    expect(input).toHaveValue("no ");

    rerender(renderShell("no ", onSearchChange));
    expect(input).toHaveValue("no ");
  });

  it("replaces the draft when the URL changes from outside the search box", () => {
    const onSearchChange = vi.fn();
    const { rerender } = render(renderShell("", onSearchChange));
    const input = screen.getByPlaceholderText("Search markets...");

    fireEvent.change(input, { target: { value: "n" } });
    fireEvent.change(input, { target: { value: "no" } });
    rerender(renderShell("n", onSearchChange));
    // Clear all navigates to the bare route before "no" commits.
    rerender(renderShell("", onSearchChange));
    expect(input).toHaveValue("");

    rerender(renderShell("restored", onSearchChange));
    expect(input).toHaveValue("restored");
  });
});
