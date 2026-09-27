import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

interface NativeDialogProps {
  ariaLabel: string;
  canDismiss?: boolean;
  dismissOnBackdrop?: boolean;
  onDismiss: () => void;
  children: (dismiss: () => void) => ReactNode;
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  dialog.close();
}

function openDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  dialog.showModal();
}

/**
 * Put one owner-controlled overlay sequence in the browser top layer.
 * The owner still decides what dismissal means for its payment state.
 */
export function NativeDialog({
  ariaLabel,
  canDismiss = true,
  dismissOnBackdrop = true,
  onDismiss,
  children,
}: NativeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dismiss = useCallback(() => {
    if (!canDismiss) return;
    onDismiss();
  }, [canDismiss, onDismiss]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    openDialog(dialog);
    return () => closeDialog(dialog);
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={ariaLabel}
      className="fixed inset-0 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-transparent p-0 backdrop:bg-black/60"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      onClick={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) dismiss();
      }}
    >
      {children(dismiss)}
    </dialog>
  );
}
