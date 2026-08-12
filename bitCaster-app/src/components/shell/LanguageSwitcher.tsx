import { useTranslation } from "react-i18next";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const currentLang = i18n.language.startsWith("ja") ? "ja" : "en";

  const toggle = () => {
    const next = currentLang === "en" ? "ja" : "en";
    void i18n.changeLanguage(next);
  };

  return (
    <button
      onClick={toggle}
      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
      aria-label="Toggle language"
    >
      {currentLang === "en" ? "日本語" : "English"}
    </button>
  );
}
