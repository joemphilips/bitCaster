import { useCallback, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { useBalance, useWalletStore } from "@/stores/wallet";
import {
  executeGuiLocalWalletPayment,
  retryGuiEcashDeposit,
  type GuiEcashDepositState,
  type GuiEcashDepositStatusReader,
  type GuiEcashDepositSubmission,
  type GuiLocalWalletPaymentResult,
} from "@/lib/guiMarketFundingPayment";
import {
  formatMarketSubunits,
  marketUnitLabel,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";

interface LocalWalletPayButtonProps {
  amountSubunits: number;
  baseAsset: string;
  unit: CashuProofUnit;
  disabled?: boolean;
  pending?: boolean;
  failed?: boolean;
  testId?: string;
  conditionId: string;
  divisibility: number;
  fundAmm: boolean;
  resolveFundingIdentity: () => {
    fundingIdentity: string;
    creatorPubkey: string | null;
  };
  getTokenPaymentStatus: GuiEcashDepositStatusReader["getStatus"];
  retryDepositId?: string | null;
  onPaymentResult: (result: GuiLocalWalletPaymentResult) => void;
  loadingLabel?: string;
  retryLabel?: string;
  payLabel?: string;
  topUpTitle?: string;
  topUpRequiredDescription?: string;
  topUpMinimumDescription?: string;
  topUpMinimumErrorDescription?: string;
  onTokenPayment: (submission: GuiEcashDepositSubmission) => Promise<{
    depositId: string;
    state: GuiEcashDepositState;
  }>;
}

/**
 * Spend regular local-wallet proofs into a bearer ecash token and submit that
 * token to a caller-owned payment endpoint. The synchronous `inflightRef`
 * mirrors `TopUpOverlay`: button disabled state is one render late, so the ref
 * is the double-click guard that protects proof selection/reservation.
 */
export function LocalWalletPayButton({
  amountSubunits,
  baseAsset,
  unit,
  disabled = false,
  pending = false,
  failed = false,
  testId,
  conditionId,
  divisibility,
  fundAmm,
  resolveFundingIdentity,
  getTokenPaymentStatus,
  retryDepositId = null,
  onPaymentResult,
  loadingLabel,
  retryLabel,
  payLabel,
  topUpTitle,
  topUpRequiredDescription,
  topUpMinimumDescription,
  topUpMinimumErrorDescription,
  onTokenPayment,
}: LocalWalletPayButtonProps) {
  const { t } = useTranslation();
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const balance = useBalance(activeMintUrl, { baseAsset });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topUpStage, setTopUpStage] = useState<"closed" | "modal" | "overlay">(
    "closed",
  );
  const inflightRef = useRef(false);
  const unitLabel = marketUnitLabel(baseAsset);
  const labelAmount = formatMarketSubunits(amountSubunits, baseAsset);
  const deficit = Math.max(amountSubunits - balance, 0);

  const handlePay = useCallback(async () => {
    if (inflightRef.current || disabled || pending || amountSubunits < 1)
      return;
    if (!retryDepositId && balance < amountSubunits) {
      setTopUpStage("modal");
      return;
    }

    inflightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const remote = {
        currentFundingIdentity: () => resolveFundingIdentity().fundingIdentity,
        getStatus: getTokenPaymentStatus,
        submit: onTokenPayment,
      };
      const result = retryDepositId
        ? await retryGuiEcashDeposit(retryDepositId, remote)
        : await executeGuiLocalWalletPayment({
            mintUrl: activeMintUrl,
            amountSubunits,
            baseAsset,
            unit,
            request: {
              conditionId,
              divisibility,
              fundAmm,
              ...resolveFundingIdentity(),
            },
            remote,
          });
      onPaymentResult(result);
      if (result.status === "insufficient") setTopUpStage("modal");
      if (result.status === "transport-ambiguous") setError(result.error);
    } catch (err) {
      setError(paymentErrorMessage(err, t("marketCreation.ecashSubmitError")));
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
  }, [
    activeMintUrl,
    amountSubunits,
    balance,
    baseAsset,
    conditionId,
    disabled,
    divisibility,
    fundAmm,
    getTokenPaymentStatus,
    onPaymentResult,
    onTokenPayment,
    pending,
    resolveFundingIdentity,
    retryDepositId,
    t,
    unit,
  ]);

  const handleTopUpSuccess = useCallback(() => {
    setTopUpStage("closed");
  }, []);

  return (
    <>
      <button
        data-testid={testId}
        type="button"
        onClick={handlePay}
        disabled={disabled || loading || pending || amountSubunits < 1}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        {loading ? (
          <span className="inline-flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {loadingLabel ?? t("marketCreation.payingFromWallet")}
          </span>
        ) : failed ? (
          (retryLabel ?? t("marketCreation.retryWalletPayment"))
        ) : (
          (payLabel ??
          t("marketCreation.payWalletFunding", { amount: labelAmount }))
        )}
      </button>

      {error && (
        <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
          {error}
        </p>
      )}

      {topUpStage === "modal" && (
        <InsufficientBalanceModal
          balance={balance}
          required={amountSubunits}
          title={
            topUpTitle ??
            t("marketCreation.depositWalletTopUpTitle", { unit: unitLabel })
          }
          requiredDescription={
            topUpRequiredDescription ??
            t("marketCreation.depositWalletTopUpRequiredDescription")
          }
          formatAmount={(amount) => formatMarketSubunits(amount, baseAsset)}
          onCancel={() => setTopUpStage("closed")}
          onTopUp={() => setTopUpStage("overlay")}
        />
      )}

      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={deficit}
          baseAsset={baseAsset}
          proofUnit={unit}
          minimumDescription={
            topUpMinimumDescription ??
            t("marketCreation.depositWalletTopUpMinimumDescription", {
              amount: formatMarketSubunits(deficit, baseAsset),
            })
          }
          minimumErrorDescription={
            topUpMinimumErrorDescription ??
            t("marketCreation.depositWalletTopUpMinimumError", {
              amount: formatMarketSubunits(deficit, baseAsset),
            })
          }
          onSuccess={handleTopUpSuccess}
          onCancel={() => setTopUpStage("closed")}
        />
      )}
    </>
  );
}

function paymentErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message;
  }
  return fallback;
}
