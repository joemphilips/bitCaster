import { X, Bitcoin } from "lucide-react";
import type { MintInfo } from "@/types/deposit-withdraw";
import { MintSelector } from "./MintSelector";
import { AmountDisplay } from "./AmountDisplay";
import { Numpad } from "./Numpad";
import { useTranslation } from "react-i18next";
import { formatUnitName, formatUnitSubunitName } from "@/lib/formatAmount";
import type { MarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";

interface DepositLightningProps {
  mints: MintInfo[];
  selectedMintId: string;
  amountSats: number;
  amountLabel?: string;
  selectedUnit?: MarketBaseAsset;
  unitOptions?: MarketBaseAsset[];
  amountFiat: string;
  fiatSymbol: string;
  showFiatPrimary: boolean;
  onMintChange?: (mintId: string) => void;
  onUnitChange?: (unit: MarketBaseAsset) => void;
  onNumpadPress?: (key: string) => void;
  onToggleCurrency?: () => void;
  onCreateInvoice?: () => void;
  onClose?: () => void;
}

export function DepositLightning({
  mints,
  selectedMintId,
  amountSats,
  amountLabel,
  selectedUnit = "sat",
  unitOptions = ["sat"],
  amountFiat,
  fiatSymbol,
  showFiatPrimary,
  onMintChange,
  onUnitChange,
  onNumpadPress,
  onToggleCurrency,
  onCreateInvoice,
  onClose,
}: DepositLightningProps) {
  const { t } = useTranslation();
  const showUnitSelector = unitOptions.length > 1;

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={() => onClose?.()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Deposit Lightning</h2>
        <div className="p-1.5 text-slate-400">
          <Bitcoin className="w-5 h-5" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
        {/* Mint selector */}
        <div className="px-5 pt-2">
          <MintSelector
            mints={mints}
            selectedMintId={selectedMintId}
            selectedUnit={selectedUnit}
            onMintChange={onMintChange}
          />
          {showUnitSelector && (
            <div className="mt-3">
              <label className="block text-xs text-slate-400 mb-1">{t("deposit.unit")}</label>
              <div className="grid grid-cols-2 gap-2">
                {unitOptions.map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={unit === selectedUnit}
                    onClick={() => onUnitChange?.(unit)}
                    className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                      unit === selectedUnit
                        ? "border-amber-400 bg-amber-400/10 text-amber-200"
                        : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600"
                    }`}
                  >
                    {formatUnitName(unit)}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {t("deposit.amountUnitHint", { unit: formatUnitSubunitName(selectedUnit) })}
              </p>
            </div>
          )}
        </div>

        {/* Amount */}
        <div className="flex-1 flex items-center justify-center">
          <AmountDisplay
            amountSats={amountSats}
            amountLabel={amountLabel}
            amountFiat={amountFiat}
            fiatSymbol={fiatSymbol}
            showFiatPrimary={showFiatPrimary}
            showFiatToggle={selectedUnit === "sat"}
            onToggleCurrency={onToggleCurrency}
          />
        </div>

        {/* Numpad */}
        <Numpad onPress={onNumpadPress} />

        {/* Action button */}
        <div className="px-5 py-6">
          <button
            onClick={() => onCreateInvoice?.()}
            disabled={amountSats === 0}
            className="w-full py-4 rounded-xl text-base font-bold uppercase tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-slate-200 text-slate-900 hover:bg-white active:bg-slate-300 disabled:hover:bg-slate-200"
          >
            Create Invoice
          </button>
        </div>
      </div>
    </div>
  );
}
