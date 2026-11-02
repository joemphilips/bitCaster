import { describe, expect, it } from "vitest";
import { ownProfileImageUrl } from "@/lib/ownProfileImageUrl";

describe("ownProfileImageUrl", () => {
  it("accepts http and https URLs, also on a local host", () => {
    expect(ownProfileImageUrl("https://images.example/avatar.png")).toBe(
      "https://images.example/avatar.png",
    );
    expect(ownProfileImageUrl(" http://localhost:5173/__e2e/profile-avatar.svg ")).toBe(
      "http://localhost:5173/__e2e/profile-avatar.svg",
    );
  });

  it("refuses other schemes, credentials and non-strings", () => {
    expect(ownProfileImageUrl("javascript:alert(1)")).toBeUndefined();
    expect(ownProfileImageUrl("data:image/png;base64,AAAA")).toBeUndefined();
    expect(ownProfileImageUrl("https://user:pass@images.example/a.png")).toBeUndefined();
    expect(ownProfileImageUrl("//images.example/a.png")).toBeUndefined();
    expect(ownProfileImageUrl(undefined)).toBeUndefined();
    expect(ownProfileImageUrl(42)).toBeUndefined();
  });
});
