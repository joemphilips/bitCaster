import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveEnvironmentDestination } from "./environmentDestination";

interface EnvironmentLinkProps {
  className?: string;
  onClick?: () => void;
}

/** Both menus use this plain external link. It carries no current route or wallet state. */
export function EnvironmentLink({ className, onClick }: EnvironmentLinkProps) {
  const { t } = useTranslation();
  const destination = resolveEnvironmentDestination(
    import.meta.env.VITE_BITCASTER_ENVIRONMENT,
    import.meta.env.VITE_ALTERNATE_ORIGIN,
    typeof window === "undefined" ? "" : window.location.origin,
  );
  if (!destination) return null;

  return (
    <a
      href={destination.href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={onClick}
    >
      <span>
        {t(destination.environment === "mainnet" ? "nav.goToMainnet" : "nav.goToTestnet")}
      </span>
      <ExternalLink className="w-4 h-4 ml-auto" aria-hidden="true" />
    </a>
  );
}
