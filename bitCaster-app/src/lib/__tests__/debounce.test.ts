import { describe, expect, it, vi } from "vitest";

import { debounce } from "../debounce";

describe("debounce", () => {
  it("coalesces trailing calls into one invocation with the latest args", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn, 200);

      debounced("first");
      debounced("second");
      vi.advanceTimersByTime(199);
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports leading plus trailing delivery", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn, 200, { leading: true, trailing: true });

      debounced("first");
      debounced("second");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenLastCalledWith("first");

      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith("second");
    } finally {
      vi.useRealTimers();
    }
  });
});
