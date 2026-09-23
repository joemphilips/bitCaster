import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Check, Info, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  BrowserMarketFundingInsufficientBalanceError,
  executeBrowserMarketFundingDelivery,
  readBrowserMarketFundingHeadId,
  type BrowserMarketFundingDeliveryResult,
  type MarketFundingDeliveryProgress,
} from "@/lib/browserMarketFundingDelivery";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { resolveCreatorPubkey } from "@/lib/identityOps";
import { useSettingsStore } from "@/stores/settings";
import { useBalance, useWalletStore } from "@/stores/wallet";
import type { MarketBaseAsset } from "@/types/market-creation";
import {
  defaultCollateralUnit,
  formatMarketSubunits,
  normalizeMarketDivisibility,
  parseSatsToMsat,
  type MarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";

function parseFundingAmount(value: string): number | null {
  if (value.trim() === "") return null;
  try {
    return parseSatsToMsat(value.trim());
  } catch {
    return null;
  }
}

function formatFundingInput(amountMsat: number): string {
  const wholeSats = Math.floor(amountMsat / 1_000);
  const fractionalMsat = amountMsat % 1_000;
  if (fractionalMsat === 0) return String(wholeSats);
  return `${wholeSats}.${String(fractionalMsat).padStart(3, "0").replace(/0+$/, "")}`;
}

interface DepositStepProps {
  /** The just-created market's condition id, returned by `createMarket`. */
  conditionId: string;
  /** Kept for wizard prop compatibility with older call sites. */
  defaultAmountSats: number;
  /** Outcome count controls the categorical AMM funding scale. */
  outcomeCount?: number;
  /** Market collateral unit. Legacy `*Sats` fields below are base subunits. */
  baseAsset?: MarketBaseAsset;
  /** Controls whether this component is the creation handoff or an embedded detail view. */
  presentation?: "creation" | "detail";
  /** Registered market divisibility. */
  divisibility: MarketDivisibility;
  /** Open the existing wallet setup chooser before a wallet-owned action. */
  onRequireWallet?: () => void;
}

export function DepositStep({
  conditionId,
  baseAsset = "sat",
  presentation = "creation",
  divisibility: divisibilityInput,
  outcomeCount,
  onRequireWallet,
}: DepositStepProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [fundingAmountSats, setFundingAmountSats] = useState("");
  const [stage, setStage] = useState<"created" | "funding">(
    presentation === "detail" ? "funding" : "created",
  );
  const [deliveryProgress, setDeliveryProgress] = useState<MarketFundingDeliveryProgress | null>(
    null,
  );
  const [fundingBusy, setFundingBusy] = useState(false);
  const [headTransferId, setHeadTransferId] = useState<string | null>(null);
  const [headReady, setHeadReady] = useState(false);
  const [headReadRevision, setHeadReadRevision] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [topUpStage, setTopUpStage] = useState<"closed" | "modal" | "overlay">("closed");
  const [error, setError] = useState<string | null>(null);
  const cashuUnit = defaultCollateralUnit(baseAsset);
  const activeMintUrl = useWalletStore((state) => state.activeMintUrl);
  const walletMnemonic = useWalletStore((state) => state.mnemonic);
  const accountSubject = useSettingsStore((settings) =>
    resolveCreatorPubkey({
      nostrSignerMode: settings.nostrSignerMode,
      nsecSecret: settings.nsecSecret,
      nostrProfilePubkey: settings.nostrProfile?.pubkey,
    }),
  );
  const balance = useBalance(activeMintUrl, { baseAsset });
  const divisibility = normalizeMarketDivisibility(divisibilityInput, baseAsset);
  const fundingAmountMsat = useMemo(
    () => parseFundingAmount(fundingAmountSats),
    [fundingAmountSats],
  );
  const fundingAmountInputError = fundingAmountSats.trim() !== "" && fundingAmountMsat === null;

  const applyFundingResult = useCallback((result: BrowserMarketFundingDeliveryResult) => {
    setHeadTransferId(result.transfer.transferId);
    setFundingAmountSats(formatFundingInput(Number(result.transfer.requestedAmount)));
    setDeliveryProgress(result.progress);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    setHeadReady(false);
    setHeadTransferId(null);
    setDeliveryProgress(null);
    setError(null);
    inFlight.current = false;
    if (!walletMnemonic.trim() || !accountSubject) {
      setHeadReady(true);
      setFundingBusy(false);
      return;
    }
    setFundingBusy(true);
    const common = {
      accountSubject,
      conditionId,
      mintUrl: activeMintUrl,
      unit: cashuUnit,
      divisibility,
    };
    void (async () => {
      try {
        const exactId = await readBrowserMarketFundingHeadId(common);
        if (cancelled || current !== generation.current) return;
        setHeadTransferId(exactId);
        if (exactId !== null) {
          const result = await executeBrowserMarketFundingDelivery({
            ...common,
            attempt: { kind: "resume", transferId: exactId },
          });
          if (cancelled || current !== generation.current) return;
          applyFundingResult(result);
        }
        setHeadReady(true);
      } catch (err) {
        if (!cancelled && current === generation.current) {
          setError(err instanceof Error ? err.message : t("marketCreation.ecashSubmitError"));
        }
      } finally {
        if (!cancelled && current === generation.current) setFundingBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [
    accountSubject,
    activeMintUrl,
    walletMnemonic,
    conditionId,
    cashuUnit,
    divisibility,
    applyFundingResult,
    headReadRevision,
    t,
  ]);

  useEffect(() => {
    if (presentation === "detail") return undefined;
    const timer = window.setTimeout(() => setStage("funding"), 5_000);
    return () => window.clearTimeout(timer);
  }, [presentation]);

  const continueToMarket = useCallback(() => {
    if (presentation === "detail") return;
    navigate(`/markets/${conditionId}`);
  }, [conditionId, navigate, presentation]);

  useEffect(() => {
    if (presentation === "detail" || deliveryProgress !== "credited" || fundingBusy)
      return undefined;
    const timer = window.setTimeout(continueToMarket, 5_000);
    return () => window.clearTimeout(timer);
  }, [continueToMarket, deliveryProgress, presentation, fundingBusy]);

  const submitMarketFunding = useCallback(async () => {
    if (fundingBusy || inFlight.current) return;
    const resuming = headTransferId !== null && deliveryProgress !== "credited";
    if (!resuming && (fundingAmountMsat === null || fundingAmountMsat < 1)) {
      setError(t("marketCreation.ammFundingAmountError"));
      return;
    }
    if (!resuming && fundingAmountMsat !== null && fundingAmountMsat % divisibility !== 0) {
      setError(t("marketCreation.ammFundingDivisibilityError", { divisibility }));
      return;
    }
    if (!walletMnemonic.trim()) {
      if (onRequireWallet) {
        onRequireWallet();
        return;
      }
      setError(t("marketCreation.ammFundingWalletRequired"));
      return;
    }
    setError(null);
    if (!headReady) return;
    const current = generation.current;
    const attempt =
      headTransferId !== null && deliveryProgress !== "credited"
        ? { kind: "resume" as const, transferId: headTransferId }
        : {
            kind: "begin" as const,
            expectedPreviousTransferId: headTransferId,
            newAttemptId: crypto.randomUUID(),
            requestedAmount: String(fundingAmountMsat),
          };
    inFlight.current = true;
    setFundingBusy(true);
    try {
      if (!accountSubject) throw new Error("The active wallet identity is unavailable.");
      const result = await executeBrowserMarketFundingDelivery({
        accountSubject,
        conditionId,
        mintUrl: activeMintUrl,
        unit: cashuUnit,
        divisibility,
        outcomeCount,
        attempt,
        availableAmount: balance,
      });
      if (current === generation.current) applyFundingResult(result);
    } catch (err) {
      if (current !== generation.current) return;
      if (err instanceof BrowserMarketFundingInsufficientBalanceError) {
        setTopUpStage("modal");
        return;
      }
      setError(err instanceof Error ? err.message : t("marketCreation.ecashSubmitError"));
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setFundingBusy(false);
      }
    }
  }, [
    activeMintUrl,
    accountSubject,
    applyFundingResult,
    headReady,
    headTransferId,
    balance,
    cashuUnit,
    conditionId,
    deliveryProgress,
    divisibility,
    outcomeCount,
    fundingAmountMsat,
    fundingBusy,
    onRequireWallet,
    t,
    walletMnemonic,
  ]);

  const canSubmitFunding =
    headReady &&
    !fundingBusy &&
    ((headTransferId !== null && deliveryProgress !== "credited") ||
      (fundingAmountMsat !== null && fundingAmountMsat > 0));

  if (stage === "created") {
    return (
      <div className="w-full max-w-xl">
        <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300">
          <Check className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
          {t("marketCreation.marketCreatedTitle")}
        </h2>
        <p className="text-sm text-slate-400 mb-6">
          {t("marketCreation.marketCreatedAttractTraders")}
        </p>
        <button
          type="button"
          onClick={() => setStage("funding")}
          className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          {t("marketCreation.attractTraders")}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t("marketCreation.ammFundingTitle")}
      </h2>
      <p className="text-sm text-slate-400 mb-5">{t("marketCreation.ammFundingSubtitle")}</p>

      <label className="mb-5 block rounded-lg border border-slate-800 bg-slate-900 p-4">
        <span className="mb-2 block text-sm font-semibold text-white">
          {t("marketCreation.ammFundingAmountLabel")}
        </span>
        <input
          data-testid="amm-funding-custom-budget"
          type="text"
          inputMode="decimal"
          aria-invalid={fundingAmountInputError ? "true" : "false"}
          aria-describedby="amm-funding-amount-hint"
          value={fundingAmountSats}
          disabled={fundingBusy || (headTransferId !== null && deliveryProgress !== "credited")}
          onChange={(event) => setFundingAmountSats(event.target.value)}
          className={`w-full rounded-lg border bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400 ${
            fundingAmountInputError ? "border-red-400" : "border-slate-700"
          }`}
        />
        <span id="amm-funding-amount-hint" className="mt-2 block text-xs text-slate-400">
          {t("marketCreation.ammFundingAmountHint")}
        </span>
      </label>

      <div className="mb-4 flex gap-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.75} />
        <p>{t("marketCreation.ammFundingDisclosure")}</p>
      </div>

      {deliveryProgress && (
        <p className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          {deliveryProgress === "credited"
            ? t("marketCreation.statusPaymentCredited")
            : deliveryProgress === "received"
              ? t("marketCreation.statusPaymentReceived")
              : t("marketCreation.statusAwaitingPayment")}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button
          data-testid="confirm-amm-funding"
          type="button"
          onClick={() => void submitMarketFunding()}
          disabled={!canSubmitFunding}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 sm:flex-1"
        >
          {fundingBusy ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("marketCreation.payingFromWallet")}
            </span>
          ) : deliveryProgress === "pending" || deliveryProgress === "received" ? (
            t("marketCreation.retryWalletPayment")
          ) : (
            t("marketCreation.payWalletFunding", {
              amount: formatMarketSubunits(fundingAmountMsat ?? 0, baseAsset),
            })
          )}
        </button>
        {presentation === "creation" && (
          <button
            data-testid="skip-amm-funding"
            type="button"
            onClick={continueToMarket}
            className="w-full rounded-lg border border-slate-700 px-4 py-3 font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800 sm:flex-1"
          >
            {t("marketCreation.skipFunding")}
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
          <p role="alert" data-testid="amm-funding-error">
            {error}
          </p>
          {!headReady && !fundingBusy && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setHeadReadRevision((value) => value + 1);
              }}
              className="mt-2 underline"
            >
              {t("marketCreation.retryWalletPayment")}
            </button>
          )}
        </div>
      )}

      {topUpStage === "modal" && (
        <InsufficientBalanceModal
          balance={balance}
          required={fundingAmountMsat ?? 0}
          title={t("marketCreation.depositWalletTopUpTitle")}
          requiredDescription={t("marketCreation.depositWalletTopUpRequiredDescription")}
          formatAmount={(amount) => formatMarketSubunits(amount, baseAsset)}
          onCancel={() => setTopUpStage("closed")}
          onTopUp={() => setTopUpStage("overlay")}
        />
      )}

      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={Math.max((fundingAmountMsat ?? 0) - balance, 0)}
          baseAsset={baseAsset}
          proofUnit={cashuUnit}
          minimumDescription={t("marketCreation.depositWalletTopUpMinimumDescription", {
            amount: formatMarketSubunits(
              Math.max((fundingAmountMsat ?? 0) - balance, 0),
              baseAsset,
            ),
          })}
          minimumErrorDescription={t("marketCreation.depositWalletTopUpMinimumError", {
            amount: formatMarketSubunits(
              Math.max((fundingAmountMsat ?? 0) - balance, 0),
              baseAsset,
            ),
          })}
          onSuccess={() => setTopUpStage("closed")}
          onCancel={() => setTopUpStage("closed")}
        />
      )}
    </div>
  );
}
