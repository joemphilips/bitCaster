// The stopped page does not load the app translations: their language detector writes to
// localStorage, and this page must not change the storage of this origin.
export type StoppedPageLanguage = "en" | "ja";

export interface StoppedPageText {
  readonly languageName: string;
  readonly title: string;
  readonly unavailable: string;
  readonly recovery: string;
  readonly privacy: string;
  readonly showPhrase: string;
  readonly hidePhrase: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly noWallet: string;
  /** Each element is one paragraph. The operator's line breaks stay. */
  readonly contact: readonly string[];
}

const CONTACT_ADDRESS = "everyday_animate734@simplelogin.com";

export const STOPPED_PAGE_TEXT: Readonly<Record<StoppedPageLanguage, StoppedPageText>> = {
  en: {
    languageName: "English",
    title: "bitCaster is temporarily unavailable.",
    unavailable: "We have not decided when it will return.",
    recovery:
      "This browser still holds your wallet. You can show your recovery phrase here. Write it down and keep it in a safe place. With the recovery phrase, you can restore your funds, for example with the bitCaster CLI.",
    privacy: "Make sure that no one can see your screen.",
    showPhrase: "Show recovery phrase",
    hidePhrase: "Hide recovery phrase",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed. Write the words down.",
    noWallet: "This browser has no bitCaster wallet.",
    contact: [`To contact us, write to ${CONTACT_ADDRESS}.`],
  },
  ja: {
    languageName: "日本語",
    title: "bitcasterは現在一時的に公開を停止しています",
    unavailable: "再開時期は未定です",
    recovery:
      "このブラウザーには、まだあなたのウォレットが残っています。ここで復元フレーズを表示できます。書き写して、安全な場所に保管してください。復元フレーズがあれば、bitCaster CLI などで資金を復元できます。",
    privacy: "画面を他の人に見られないようにしてください。",
    showPhrase: "復元フレーズを表示",
    hidePhrase: "復元フレーズを隠す",
    copy: "コピー",
    copied: "コピーしました",
    copyFailed: "コピーできませんでした。書き写してください。",
    noWallet: "このブラウザーには bitCaster のウォレットがありません。",
    contact: [`連絡を取りたい方は${CONTACT_ADDRESS}`, "まで連絡ください"],
  },
};

/** The language of the app (read only), then the browser language. */
export function initialStoppedPageLanguage(
  storage: Pick<Storage, "getItem">,
  browserLanguage: string | undefined,
): StoppedPageLanguage {
  let appLanguage: string | null = null;
  try {
    appLanguage = storage.getItem("i18nextLng");
  } catch {
    appLanguage = null;
  }
  const language = appLanguage ?? browserLanguage ?? "en";
  return language.toLowerCase().startsWith("ja") ? "ja" : "en";
}
