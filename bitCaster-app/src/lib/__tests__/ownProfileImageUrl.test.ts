import { describe, expect, it } from "vitest";
import { ownProfileImageUrl } from "@/lib/ownProfileImageUrl";

const SVG_DATA = "%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";

describe("ownProfileImageUrl", () => {
  it("accepts http and https URLs, also on a local host", () => {
    expect(ownProfileImageUrl("https://images.example/avatar.png")).toBe(
      "https://images.example/avatar.png",
    );
    expect(ownProfileImageUrl(" http://localhost:5173/__e2e/profile-avatar.svg ")).toBe(
      "http://localhost:5173/__e2e/profile-avatar.svg",
    );
  });

  it.each([
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
    "data:image/svg+xml;base64,PHN2Zy8+",
    `data:image/svg+xml,${SVG_DATA}`,
  ])("accepts the data image URI %s", (value) => {
    expect(ownProfileImageUrl(value)).toBe(value);
  });

  it("returns the canonical form of a data image URI", () => {
    expect(ownProfileImageUrl(` DATA:IMAGE/SVG+XML,${SVG_DATA}\n`)).toBe(
      `data:image/svg+xml,${SVG_DATA}`,
    );
  });

  it("refuses other schemes, data types, credentials and non-strings", () => {
    expect(ownProfileImageUrl("javascript:alert(1)")).toBeUndefined();
    expect(ownProfileImageUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeUndefined();
    expect(ownProfileImageUrl("data:image/bmp;base64,Qk0=")).toBeUndefined();
    expect(ownProfileImageUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeUndefined();
    expect(ownProfileImageUrl(`data:image/svg+xml,${"a".repeat(65_536)}`)).toBeUndefined();
    expect(ownProfileImageUrl("https://user:pass@images.example/a.png")).toBeUndefined();
    expect(ownProfileImageUrl("//images.example/a.png")).toBeUndefined();
    expect(ownProfileImageUrl(undefined)).toBeUndefined();
    expect(ownProfileImageUrl(42)).toBeUndefined();
  });
});
