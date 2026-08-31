import { useEffect, useState, type ReactNode } from "react";
import { resetPreReleaseBrowserState } from "./browserPreReleaseReset";

type BootState = "resetting" | "ready" | "failed";

export interface BrowserPreReleaseResetGateProps {
  readonly children: ReactNode;
  readonly reset?: () => Promise<boolean>;
  readonly reload?: () => void;
}

/** Prevent recovery workers from mounting until the pre-release reset finishes. */
export function BrowserPreReleaseResetGate({
  children,
  reset = resetPreReleaseBrowserState,
  reload = () => window.location.reload(),
}: BrowserPreReleaseResetGateProps) {
  const [bootState, setBootState] = useState<BootState>("resetting");

  useEffect(() => {
    let active = true;
    reset()
      .then((resetApplied) => {
        if (!active) return;
        if (resetApplied) {
          reload();
          return;
        }
        setBootState("ready");
      })
      .catch(() => {
        if (active) setBootState("failed");
      });
    return () => {
      active = false;
    };
  }, [reload, reset]);

  if (bootState === "failed") {
    return (
      <div className="p-4 text-sm text-red-200" role="alert">
        The browser profile reset failed. Clear this site&apos;s data and reload.
      </div>
    );
  }
  if (bootState !== "ready") return null;
  return <>{children}</>;
}
