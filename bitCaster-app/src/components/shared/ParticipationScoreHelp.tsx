import { useTranslation } from "react-i18next";
import { HelpTip } from "./HelpTip";

/** The "?" explanation that goes next to each visible use of Participation Score. */
export function ParticipationScoreHelp({ testId }: { testId?: string }) {
  const { t } = useTranslation();
  return (
    <HelpTip
      label={t("participationScore.helpLabel")}
      content={t("participationScore.help")}
      testId={testId}
    />
  );
}
