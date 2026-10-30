import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePublicCommentProfiles } from "../usePublicCommentProfiles";
const fetchProfile = vi.hoisted(() => vi.fn());
vi.mock("../nostr", () => ({ fetchPublicNostrProfile: fetchProfile }));
afterEach(() => {
  cleanup();
  fetchProfile.mockReset();
});
const author = "a".repeat(64);
function Consumer({ label }: { label: string }) {
  const profiles = usePublicCommentProfiles([author]);
  return <div data-testid={label}>{profiles.get(author)?.displayName ?? author}</div>;
}
it("shares refreshed names between mounted chart and thread consumers", async () => {
  let resolve!: (value: unknown) => void;
  fetchProfile.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<Consumer label="chart" />);
  expect(screen.getByTestId("chart")).toHaveTextContent(author);
  await act(async () => resolve({ pubkey: author, displayName: "Alice", avatar: "" }));
  expect(screen.getByTestId("chart")).toHaveTextContent("Alice");
  fetchProfile.mockResolvedValue({ pubkey: author, displayName: "Alice Updated", avatar: "" });
  await act(async () =>
    view.rerender(
      <>
        <Consumer label="chart" />
        <Consumer label="thread" />
      </>,
    ),
  );
  expect(screen.getByTestId("chart")).toHaveTextContent("Alice Updated");
  expect(screen.getByTestId("thread")).toHaveTextContent("Alice Updated");
});

it("cancels its read lease on unmount and does not broadcast late results", async () => {
  let resolve!: (value: unknown) => void;
  fetchProfile.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<Consumer label="chart" />);
  const signal = fetchProfile.mock.calls[0]![1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(null));
});
