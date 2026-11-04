import { Copy } from "lucide-react";
import { useToastStore } from "@/stores/toast";

const ICON_SIZE_CLASSES = { md: "w-4 h-4", sm: "h-3.5 w-3.5" } as const;

interface CopyNpubButtonProps {
  /** The value that a user pastes to mention the person. */
  npub: string;
  label: string;
  copiedMessage: string;
  failedMessage: string;
  /** Padding, margin, and color classes. The control sets its shape. */
  className: string;
  /** Use "sm" in a compact header. */
  iconSize?: keyof typeof ICON_SIZE_CLASSES;
}

export function CopyNpubButton({
  npub,
  label,
  copiedMessage,
  failedMessage,
  className,
  iconSize = "md",
}: CopyNpubButtonProps) {
  // Report success only after the clipboard write completes.
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(npub);
      useToastStore.getState().addToast({ type: "success", message: copiedMessage });
    } catch {
      useToastStore.getState().addToast({ type: "error", message: failedMessage });
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={`shrink-0 rounded-full transition-colors ${className}`}
      aria-label={label}
      title={label}
    >
      <Copy className={ICON_SIZE_CLASSES[iconSize]} />
    </button>
  );
}
