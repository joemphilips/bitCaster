import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketMarkdown } from "../MarketMarkdown";

const LINK_REL = "noopener noreferrer nofollow ugc";

function renderMarkdown(source: string) {
  const view = render(<MarketMarkdown source={source} />);
  return { ...view, root: within(view.container).getByTestId("market-markdown") };
}

describe("MarketMarkdown", () => {
  it("renders resolution criteria Markdown as structured user content", () => {
    const { root } = renderMarkdown(
      [
        "Resolves **Yes** if _both_ hold:",
        "",
        "1. BTC closes above `100000` USD.",
        "2. The source is [CoinGecko](https://www.coingecko.com/en/coins/bitcoin).",
        "",
        "> Ties resolve No.",
      ].join("\n"),
    );

    expect(root).toHaveAttribute("data-user-content");
    expect(root.querySelector("strong")).toHaveTextContent("Yes");
    expect(root.querySelector("em")).toHaveTextContent("both");
    expect(root.querySelector("code")).toHaveTextContent("100000");
    expect(within(root).getAllByRole("listitem")).toHaveLength(2);
    expect(root.querySelector("blockquote")).toHaveTextContent("Ties resolve No.");
    expect(within(root).getByRole("link", { name: "CoinGecko" })).toHaveAttribute(
      "href",
      "https://www.coingecko.com/en/coins/bitcoin",
    );
  });

  it("refuses script and raw HTML", () => {
    const { container } = renderMarkdown(
      [
        "<script>window.__marketMarkdownPwned = true</script>",
        "",
        'Text <b>bold</b> <img src="https://evil.example/x.png" onerror="alert(1)">',
        "",
        '<iframe src="https://evil.example"></iframe>',
        "",
        '<a href="https://evil.example" onclick="alert(1)">html link</a>',
        "",
        "<style>body { display: none }</style>",
      ].join("\n"),
    );

    expect(
      container.querySelector("script, b, img, iframe, style, [onerror], [onclick]"),
    ).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect((window as { __marketMarkdownPwned?: boolean }).__marketMarkdownPwned).toBeUndefined();
    // Raw HTML stays visible as text, so criteria such as "<Team A>" keep their words.
    expect(container).toHaveTextContent("Text <b>bold</b>");
    expect(renderMarkdown("Resolves Yes if <Team A> wins.").root).toHaveTextContent(
      "Resolves Yes if <Team A> wins.",
    );
  });

  it.each([
    ["[js](javascript:alert(1))", "js"],
    ["[upper](JAVASCRIPT:alert(1))", "upper"],
    ["[entity](javascript&#58;alert(1))", "entity"],
    ["[vb](vbscript:msgbox(1))", "vb"],
    ["[data](data:text/html;base64,PHNjcmlwdD4=)", "data"],
    ["[file](file:///etc/passwd)", "file"],
    ["[relative](/settings)", "relative"],
    ["[fragment](#top)", "fragment"],
    ["[ftp](ftp://example.com/file)", "ftp"],
    ["[ref][r]\n\n[r]: javascript:alert(1)", "ref"],
  ])("does not create a link for %s", (source, text) => {
    const { root } = renderMarkdown(source);

    expect(root.querySelector("a")).toBeNull();
    expect(root).toHaveTextContent(text);
  });

  it("does not create a link for a javascript autolink", () => {
    const { root } = renderMarkdown("<javascript:alert(1)>");

    expect(root.querySelector("a")).toBeNull();
  });

  it.each([
    ["[site](https://example.com/path?q=1)", "site", "https://example.com/path?q=1"],
    ["[plain](http://example.com)", "plain", "http://example.com/"],
    ["[mail](mailto:oracle@example.com)", "mail", "mailto:oracle@example.com"],
    ["<https://example.com/auto>", "https://example.com/auto", "https://example.com/auto"],
  ])("opens %s in a new tab without referrer or ranking credit", (source, name, href) => {
    const { root } = renderMarkdown(source);

    const link = within(root).getByRole("link", { name });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", LINK_REL);
  });

  it("shows an image as a link with its alt text and does not load it", () => {
    const { root } = renderMarkdown(
      [
        "![BTC chart](https://example.com/chart.png)",
        "",
        "![](https://example.com/no-alt.png)",
        "",
        "![Unsafe image](javascript:alert(1))",
        "",
        "![Data image](data:image/png;base64,iVBORw0KGgo=)",
      ].join("\n"),
    );

    expect(root.querySelector("img, picture, source")).toBeNull();
    const chart = within(root).getByRole("link", { name: "BTC chart" });
    expect(chart).toHaveAttribute("href", "https://example.com/chart.png");
    expect(chart).toHaveAttribute("target", "_blank");
    expect(chart).toHaveAttribute("rel", LINK_REL);
    expect(
      within(root).getByRole("link", { name: "https://example.com/no-alt.png" }),
    ).toHaveAttribute("href", "https://example.com/no-alt.png");
    expect(within(root).getAllByRole("link")).toHaveLength(2);
    expect(root).toHaveTextContent("Unsafe image");
    expect(root).toHaveTextContent("Data image");
  });

  it("does not nest a link when an image is inside a link", () => {
    const { root } = renderMarkdown(
      "[![Badge](https://img.example/badge.png)](https://example.com)",
    );

    const links = within(root).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Badge");
    expect(links[0]).toHaveAttribute("href", "https://example.com/");
    expect(root.querySelector("a a, img")).toBeNull();
  });

  it("keeps a Markdown heading inside the page heading structure", () => {
    const { root } = renderMarkdown("# Sources\n\n## Edge cases\n\nText");

    expect(within(root).queryByRole("heading")).toBeNull();
    expect(root).toHaveTextContent("Sources");
    expect(root).toHaveTextContent("Edge cases");
  });
});
