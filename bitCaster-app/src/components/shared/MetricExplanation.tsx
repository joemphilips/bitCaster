import { useId, useState, type ReactNode } from "react";

interface MetricExplanationProps {
  label: string;
  description: string;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
  testId?: string;
}

export function MetricExplanation({
  label,
  description,
  children,
  className = "",
  align = "left",
  testId,
}: MetricExplanationProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      data-testid={testId}
      className={`relative text-left cursor-help ${className}`}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(event) => {
        event.stopPropagation();
        setOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <span className="sr-only">{label}: </span>
      {children}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute bottom-full z-50 mb-2 w-48 rounded-lg bg-slate-900 px-3 py-2 text-xs font-sans font-normal text-white shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
        >
          {description}
        </span>
      )}
    </button>
  );
}
