import { Copy } from "lucide-react";
import { useToastStore } from "@/stores/toast";

interface CopyNpubButtonProps {
  /** The value that a user pastes to mention the person. */
  npub: string;
  label: string;
  copiedMessage: string;
  failedMessage: string;
  /** Size and color classes. The control sets its shape and the icon size. */
  className: string;
}

export function CopyNpubButton({
  npub,
  label,
  copiedMessage,
  failedMessage,
  className,
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
      <Copy className="w-4 h-4" />
    </button>
  );
}
