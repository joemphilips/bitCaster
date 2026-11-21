import { Fragment } from "react";
import { useTranslation } from "react-i18next";

// The translation puts this mark where the command goes. The mark cannot
// occur in a locale text, so the split finds only the command position.
const COMMAND_MARK = "\u0000";

/**
 * A CLI command as inline code. A line can break only between two tokens of
 * the command, never inside a flag. The text content is the command, so a
 * copy gives the command unchanged.
 */
export function CliCommand({ command }: { command: string }) {
  return (
    <code className="font-mono">
      {command.split(" ").map((token, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          <span className="whitespace-nowrap">{token}</span>
        </Fragment>
      ))}
    </code>
  );
}

/** A translated text whose `{{command}}` value shows as a `CliCommand`. */
export function CliCommandText({ i18nKey, command }: { i18nKey: string; command: string }) {
  const { t } = useTranslation();
  const parts = t(i18nKey, { command: COMMAND_MARK }).split(COMMAND_MARK);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <CliCommand command={command} />}
          {part}
        </Fragment>
      ))}
    </>
  );
}
