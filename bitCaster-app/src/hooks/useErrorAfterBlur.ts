import { useState } from "react";

export interface ErrorAfterBlur {
  /** The error to show next to the field, or null. */
  readonly visibleError: string | null;
  /** Connect to the field's `onBlur`. */
  readonly onBlur: () => void;
}

/**
 * Times a field error for a rule that a partial entry can break, such as a minimum or a format.
 * A partial entry is not an error while the user types. The error appears when the user leaves
 * the field and disappears as soon as the input obeys the rule. A new break waits for the next
 * blur. Show an error for a value above a maximum directly instead: more typing cannot fix it.
 */
export function useErrorAfterBlur(error: string | null): ErrorAfterBlur {
  const [shown, setShown] = useState(false);
  // Adjust during render so that a fixed input hides its error in the same commit.
  if (error === null && shown) setShown(false);
  return {
    visibleError: shown ? error : null,
    onBlur: () => setShown(error !== null),
  };
}
