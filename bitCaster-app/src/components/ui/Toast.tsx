import { useEffect, useState } from "react";
import { Check, AlertCircle, Info, X } from "lucide-react";
import { useToastStore, type Toast, type ToastType } from "@/stores/toast";

const DEFAULT_DURATION: Record<Exclude<ToastType, "error">, number> = {
  success: 4000,
  info: 4000,
};

const TYPE_STYLES: Record<ToastType, { border: string; icon: string; bg: string }> = {
  success: {
    border: "border-green-500/50",
    icon: "text-green-400",
    bg: "bg-green-500/10",
  },
  error: {
    border: "border-red-500/50",
    icon: "text-red-400",
    bg: "bg-red-500/10",
  },
  info: {
    border: "border-blue-500/50",
    icon: "text-blue-400",
    bg: "bg-blue-500/10",
  },
};

const TYPE_ICONS: Record<ToastType, typeof Check> = {
  success: Check,
  error: AlertCircle,
  info: Info,
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (toast.type === "error") return;

    const duration = toast.duration ?? DEFAULT_DURATION[toast.type];
    const timer = setTimeout(() => removeToast(toast.id), duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.type, toast.duration, removeToast]);

  const styles = TYPE_STYLES[toast.type];
  const Icon = TYPE_ICONS[toast.type];

  return (
    <div
      className={[
        "flex items-start gap-2.5 p-3 rounded-lg border backdrop-blur-sm",
        "bg-slate-900/95 shadow-lg shadow-black/20",
        "transition-all duration-300 ease-out",
        styles.border,
        visible
          ? "opacity-100 translate-y-0 translate-x-0"
          : "opacity-0 translate-y-2 sm:translate-y-0 sm:translate-x-4",
      ].join(" ")}
    >
      <div className={["flex-shrink-0 mt-0.5 rounded-full p-1", styles.bg].join(" ")}>
        <Icon className={["w-3.5 h-3.5", styles.icon].join(" ")} strokeWidth={2} />
      </div>
      <p className="text-sm text-slate-200 flex-1 min-w-0 break-words leading-snug pt-0.5">
        {toast.message}
      </p>
      <button
        onClick={() => removeToast(toast.id)}
        aria-label="Dismiss"
        className="flex-shrink-0 p-0.5 rounded text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
      >
        <X className="w-3.5 h-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      className="fixed z-50 pointer-events-auto flex max-h-[calc(100dvh-5rem)] flex-col gap-2 overflow-y-auto top-16 left-3 right-3 sm:top-auto sm:left-auto sm:bottom-4 sm:right-4 sm:w-80"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
