import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "@/stores/toast";

interface ShareableMarket {
  title: string;
}

/**
 * P7 §`/markets/{id}` — wire the Share button so it actually shares. Two
 * paths:
 *
 *  - `navigator.share({ title, url })` when available — invokes the OS
 *    native share sheet (mobile, Safari/Edge desktop with the API enabled).
 *    Hands off to whatever target the user picks: X, Telegram, Nostr
 *    clients, copy-link, etc. We do not need to know.
 *  - clipboard fallback when `navigator.share` is undefined — write the URL
 *    to the clipboard via `navigator.clipboard.writeText` and surface a
 *    toast confirming the copy.
 *
 * Failure modes:
 *  - user cancels the share sheet → AbortError thrown by `navigator.share`
 *    → swallowed silently (cancel is not a failure).
 *  - share rejected by something other than user-cancel → also silent; the
 *    share sheet displays its own error UX. We do NOT fall back to the
 *    clipboard in this case — the user already saw the share UI; copying
 *    behind their back would be surprising.
 *  - clipboard write fails → error toast.
 *
 * OG image / description-bearing share is deliberately out of scope (would
 * require SSR for OG tags). Title + URL is sufficient for v1.
 */
export function useShareMarket(market: ShareableMarket) {
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);

  return useCallback(async () => {
    const url = window.location.href;
    const title = market.title;

    if (typeof navigator.share === "function") {
      await invokeNativeShare(navigator.share.bind(navigator), title, url);
      return;
    }

    await copyToClipboard(url, addToast, t);
  }, [market.title, t, addToast]);
}

/**
 * Invoke the OS share sheet. AbortError (user cancelled) is the documented
 * outcome we tolerate; any other rejection is also swallowed because the
 * native share UI surfaces its own error to the user, and a silent
 * clipboard fallback would be surprising.
 */
async function invokeNativeShare(
  share: (data: ShareData) => Promise<void>,
  title: string,
  url: string,
): Promise<void> {
  try {
    await share({ title, url });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    // Non-cancel rejection — leave the user where the share sheet left them.
  }
}

type Toaster = ReturnType<typeof useToastStore.getState>["addToast"];
type Translator = ReturnType<typeof useTranslation>["t"];

async function copyToClipboard(url: string, addToast: Toaster, t: Translator): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    addToast({ message: t("market.linkCopied"), type: "success" });
  } catch {
    addToast({ message: t("market.shareFailed"), type: "error" });
  }
}
