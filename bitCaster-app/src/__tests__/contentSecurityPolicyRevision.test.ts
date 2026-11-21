// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { UserConfig } from "vite";
import { expect, it } from "vitest";

// Static imports would add these modules to the app type check.
const viteConfigModule = "../../vite.config.ts";
const policyModule = "../../content-security-policy.js";

type IndexHtmlHook = (html: string, context: { path: string; filename: string }) => unknown;

// The service worker serves the precached index.html with the headers that it cached. A
// policy change must change index.html, so that the service worker fetches it again.
it("the built index.html carries the digest of the policy that the server sends", async () => {
  const { default: viteConfig } = (await import(/* @vite-ignore */ viteConfigModule)) as {
    default: UserConfig;
  };
  const { CONTENT_SECURITY_POLICY } = (await import(/* @vite-ignore */ policyModule)) as {
    CONTENT_SECURITY_POLICY: string;
  };
  const plugins = ((viteConfig.plugins ?? []) as unknown[]).flat(4) as ({
    name?: string;
    transformIndexHtml?: IndexHtmlHook;
  } | null)[];
  const plugin = plugins.find((candidate) => candidate?.name === "bitcaster-csp-revision");
  expect(plugin?.transformIndexHtml).toBeTypeOf("function");

  const tags = await plugin!.transformIndexHtml!(readFileSync("index.html", "utf8"), {
    path: "/index.html",
    filename: "index.html",
  });
  expect(tags).toContainEqual({
    tag: "meta",
    attrs: {
      name: "bitcaster-csp",
      content: createHash("sha256").update(CONTENT_SECURITY_POLICY).digest("hex"),
    },
    injectTo: "head",
  });
});
