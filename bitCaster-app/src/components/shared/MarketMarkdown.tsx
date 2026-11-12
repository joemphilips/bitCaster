import { createContext, useContext, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";

/** A creator link must not send a referrer, open access to this window, or carry ranking credit. */
const LINK_REL = "noopener noreferrer nofollow ugc";
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * CommonMark elements only. Raw HTML stays text, so this list is a second
 * guard. A disallowed element keeps its text content.
 */
const ALLOWED_ELEMENTS = [
  "p",
  "a",
  "img",
  "em",
  "strong",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "br",
];

/** Keep only an absolute http, https, or mailto URL. Refuse every other URL. */
function safeMarkdownUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

// An image inside a link becomes text, because a link cannot contain a link.
const InsideLink = createContext(false);

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel={LINK_REL}
      className="text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
    >
      <InsideLink.Provider value>{children}</InsideLink.Provider>
    </a>
  );
}

/** A remote image is not loaded. Its alt text links to the image instead. */
function ImageAsLink({ src, alt }: { src?: unknown; alt?: string }) {
  const insideLink = useContext(InsideLink);
  const href = typeof src === "string" && src !== "" ? src : undefined;
  const label = alt?.trim() || href;
  if (!href || insideLink) return <>{alt}</>;
  return <ExternalLink href={href}>{label}</ExternalLink>;
}

function HeadingText({ children }: { children?: ReactNode }) {
  // The market page owns the heading structure. A creator heading is bold text.
  return <p className="font-semibold text-slate-900 dark:text-white">{children}</p>;
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? <ExternalLink href={href}>{children}</ExternalLink> : <>{children}</>,
  img: ({ src, alt }) => <ImageAsLink src={src} alt={alt} />,
  h1: HeadingText,
  h2: HeadingText,
  h3: HeadingText,
  h4: HeadingText,
  h5: HeadingText,
  h6: HeadingText,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-slate-400/50 pl-3">{children}</blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-slate-500/15 px-1 font-mono text-[0.9em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded bg-slate-500/15 p-2 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  hr: () => <hr className="border-slate-500/30" />,
};

/**
 * Render creator Markdown, such as the resolution criteria. The market detail
 * and the creation preview use this one component, so they show the same result.
 */
export function MarketMarkdown({ source }: { source: string }) {
  return (
    <div
      data-user-content
      data-testid="market-markdown"
      className="space-y-2 [overflow-wrap:anywhere]"
    >
      <Markdown
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        components={COMPONENTS}
        urlTransform={safeMarkdownUrl}
      >
        {source}
      </Markdown>
    </div>
  );
}
