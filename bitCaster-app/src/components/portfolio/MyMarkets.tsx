import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreatedMarket } from "@/types/portfolio";
import { ChevronDown } from "lucide-react";
import { CreatedMarketRow } from "./CreatedMarketRow";
import {
  CreatorMarketActionsProvider,
  type CreatorOraclePublication,
} from "@/components/creator/CreatorMarketActions";

interface MyMarketsProps {
  markets: CreatedMarket[];
  onViewMarket?: (marketId: string) => void;
  onClaimCreatorFees?: (marketId: string) => void;
  onPublishOracleAttestation?: (marketId: string) => void;
  publishingOracleAttestationMarketId?: string | null;
  onOraclePublication?: CreatorOraclePublication;
}

export function MyMarkets({
  markets,
  onViewMarket,
  onClaimCreatorFees,
  onPublishOracleAttestation,
  publishingOracleAttestationMarketId = null,
  onOraclePublication,
}: MyMarketsProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(true);
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(markets.length / 20) - 1));

  const visibleMarkets = markets.slice(currentPage * 20, (currentPage + 1) * 20);
  const actionConditionIds = onOraclePublication
    ? visibleMarkets
        .filter((market) => market.oracleOwnerKind === "imported" || market.oracle?.destinations)
        .map((market) => market.id)
    : [];
  if (markets.length === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          {t("portfolio.myMarkets", { count: markets.length })}
        </h3>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="px-1 pb-1">
          <CreatorMarketActionsProvider conditionIds={actionConditionIds}>
            {visibleMarkets.map((market) => (
              <CreatedMarketRow
                key={market.id}
                market={market}
                onView={onViewMarket}
                onClaimFees={onClaimCreatorFees}
                onPublishOracleAttestation={onPublishOracleAttestation}
                isPublishingOracleAttestation={publishingOracleAttestationMarketId === market.id}
                onOraclePublication={onOraclePublication}
                oraclePublicationBusy={publishingOracleAttestationMarketId !== null}
              />
            ))}
          </CreatorMarketActionsProvider>
          {markets.length > 20 && (
            <nav
              className="flex gap-3 p-3"
              aria-label={t("portfolio.myMarkets", { count: markets.length })}
            >
              <button
                type="button"
                disabled={currentPage === 0 || publishingOracleAttestationMarketId !== null}
                onClick={() => setPage(currentPage - 1)}
              >
                {t("oracleBackup.previous")}
              </button>
              <button
                type="button"
                disabled={
                  (currentPage + 1) * 20 >= markets.length ||
                  publishingOracleAttestationMarketId !== null
                }
                onClick={() => setPage(currentPage + 1)}
              >
                {t("oracleBackup.next")}
              </button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
