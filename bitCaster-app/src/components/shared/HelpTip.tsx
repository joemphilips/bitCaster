import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

interface HelpTipProps {
  /** Accessible name of the "?" button, for example "About Participation Score". */
  label: string;
  /** The short explanation. Keep it to plain text; the explanation is a tooltip. */
  content: ReactNode;
  testId?: string;
}

// Focus opens the explanation only when the user moves focus with the
// keyboard. A dialog's automatic initial focus after a click must not open it.
let keyboardModality = false;
let modalityTracked = false;

function trackInputModality(): void {
  if (modalityTracked) return;
  modalityTracked = true;
  document.addEventListener(
    "keydown",
    () => {
      keyboardModality = true;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      keyboardModality = false;
    },
    true,
  );
}

const TIP_WIDTH_PX = 256;
const VIEWPORT_MARGIN_PX = 8;
const TRIGGER_GAP_PX = 4;

/**
 * A "?" button that explains one term. It opens on mouse hover, on keyboard
 * focus, and on tap or click. Escape closes it. A tap outside closes a tapped
 * explanation.
 *
 * The explanation uses fixed positioning, so a scrolling panel does not clip
 * it. It stays inside the button's DOM subtree, so it also shows above a modal
 * dialog in the browser top layer.
 */
export function HelpTip({ label, content, testId }: HelpTipProps) {
  const tipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // True from a pointer press inside the control until its click. For touch,
  // the browser moves focus after the pointer is up, so the flag must outlast
  // pointerup. A focus change in this window is not keyboard focus, and the
  // click decides the state.
  const pressRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const open = hovered || focused || pinned;

  useEffect(trackInputModality, []);

  const close = useCallback(() => {
    setHovered(false);
    setFocused(false);
    setPinned(false);
  }, []);

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (button === null) return;
    setPosition(tipPosition(button.getBoundingClientRect(), window.innerWidth, window.innerHeight));
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Consume the key, so an enclosing dialog does not also close.
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [close, open, place]);

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex align-middle"
      onPointerDownCapture={() => {
        pressRef.current = true;
      }}
      onClickCapture={() => {
        pressRef.current = false;
      }}
      onPointerCancelCapture={() => {
        pressRef.current = false;
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setHovered(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-describedby={tipId}
        aria-expanded={open}
        className="group -m-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus:outline-none"
        onFocus={() => {
          if (!pressRef.current && keyboardModality) setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          // A press on the explanation moves focus away but keeps it open.
          if (!pressRef.current) setPinned(false);
        }}
        onClick={(event) => {
          // A click toggles a kept-open explanation. It must not also act on
          // a parent row or dialog backdrop.
          event.stopPropagation();
          if (pinned) close();
          else setPinned(true);
        }}
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px] font-semibold leading-none text-slate-500 transition-colors group-hover:border-slate-500 group-hover:text-slate-700 group-focus-visible:ring-2 group-focus-visible:ring-blue-500 dark:border-slate-600 dark:text-slate-400 dark:group-hover:border-slate-400 dark:group-hover:text-slate-200"
        >
          ?
        </span>
      </button>
      <span
        id={tipId}
        role={open ? "tooltip" : undefined}
        hidden={!open}
        style={position}
        className="fixed z-50 rounded-lg bg-slate-900 px-3 py-2 text-left text-xs font-normal leading-5 text-white shadow-lg dark:bg-slate-700"
      >
        {content}
      </span>
    </span>
  );
}

/** Keep the explanation inside the viewport, below the button or above it. */
export function tipPosition(
  trigger: Pick<DOMRect, "left" | "top" | "bottom" | "width">,
  viewportWidth: number,
  viewportHeight: number,
): CSSProperties {
  const width = Math.max(0, Math.min(TIP_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX));
  const centered = trigger.left + trigger.width / 2 - width / 2;
  const left = Math.min(
    Math.max(centered, VIEWPORT_MARGIN_PX),
    Math.max(VIEWPORT_MARGIN_PX, viewportWidth - VIEWPORT_MARGIN_PX - width),
  );
  return trigger.top > viewportHeight / 2
    ? { left, width, bottom: viewportHeight - trigger.top + TRIGGER_GAP_PX }
    : { left, width, top: trigger.bottom + TRIGGER_GAP_PX };
}
