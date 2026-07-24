import type { DepositWithdrawMode } from "@/types/deposit-withdraw";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useDepositWithdrawState } from "@/pages/useDepositWithdrawState";
import { DepositWithdraw } from "./DepositWithdraw";
import { InvoiceDisplay } from "./InvoiceDisplay";
import { TokenDisplay } from "./TokenDisplay";
import { MeltConfirmation } from "./MeltConfirmation";
import { QrScannerView } from "./QrScanner";
import { PaymentRequestDisplay } from "./PaymentRequestDisplay";
import { SuccessView } from "./SuccessView";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { formatAmount } from "@/lib/formatAmount";
import { useWalletStore } from "@/stores/wallet";

const DEPOSIT_BACKUP_WARNING_DISMISSED_KEY = "bitcaster.depositBackupWarningDismissed";

interface DepositWithdrawOverlayProps {
  mode: DepositWithdrawMode;
  onClose: () => void;
}

export function DepositWithdrawOverlay({ mode, onClose }: DepositWithdrawOverlayProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const state = useDepositWithdrawState(mode, onClose);
  const walletBackupState = useWalletStore((s) => s.walletBackupState);
  const [backupWarningDismissed, setBackupWarningDismissed] = useState(
    () => window.localStorage.getItem(DEPOSIT_BACKUP_WARNING_DISMISSED_KEY) === "true",
  );
  const showBackupWarning =
    mode === "deposit" && walletBackupState === "needs_backup" && !backupWarningDismissed;

  useEffect(() => {
    if (mode !== "deposit" || walletBackupState !== "needs_backup") return;
    window.localStorage.setItem(DEPOSIT_BACKUP_WARNING_DISMISSED_KEY, "false");
    setBackupWarningDismissed(false);
  }, [mode, walletBackupState]);

  const dismissBackupWarning = () => {
    window.localStorage.setItem(DEPOSIT_BACKUP_WARNING_DISMISSED_KEY, "true");
    setBackupWarningDismissed(true);
  };

  // Error toast
  const errorBanner = state.error ? (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] bg-red-900/90 border border-red-700 text-red-200 text-sm px-4 py-2 rounded-xl max-w-sm text-center">
      {state.error}
    </div>
  ) : null;

  const backupWarningBanner = showBackupWarning ? (
    <div className="fixed left-4 right-4 top-4 z-[79] mx-auto max-w-md rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:border-amber-800/70 dark:bg-amber-950/90 dark:text-amber-100">
      <p className="font-medium">{t("backupSecrets.depositWarning")}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => navigate("/settings?category=cashu")}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
        >
          {t("backupSecrets.backupNow")}
        </button>
        <button
          type="button"
          onClick={dismissBackupWarning}
          className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/70"
        >
          {t("backupSecrets.later")}
        </button>
      </div>
    </div>
  ) : null;

  if (state.currentView === "success") {
    return (
      <SuccessView
        amountSats={state.successAmount}
        amountLabel={formatAmount(state.successAmount, state.successUnit)}
        onClose={state.onClose}
      />
    );
  }

  if (state.currentView === "scanner") {
    return (
      <>
        {backupWarningBanner}
        {errorBanner}
        <QrScannerView onDecode={state.onScanResult} onClose={state.onBack} />
      </>
    );
  }

  if (state.currentView === "payment-request-display" && state.paymentRequestEncoded) {
    return (
      <>
        {backupWarningBanner}
        {errorBanner}
        <PaymentRequestDisplay
          paymentRequestEncoded={state.paymentRequestEncoded}
          status={state.paymentRequestStatus}
          amountSats={state.amountSats}
          onClose={state.onClose}
        />
      </>
    );
  }

  if (state.currentView === "invoice-display" && state.bolt11) {
    return (
      <>
        {backupWarningBanner}
        {errorBanner}
        <InvoiceDisplay
          bolt11={state.bolt11}
          amountSats={state.amountSats}
          amountLabel={state.amountLabel}
          status={state.invoiceStatus}
          expiresAtSec={state.invoiceExpiresAtSec}
          rateInfo={state.invoiceRateInfo}
          errorMessage={state.error}
          onClose={state.onClose}
          onRegenerate={state.onRegenerateInvoice}
        />
      </>
    );
  }

  if (state.currentView === "token-display" && state.ecashToken) {
    return (
      <>
        {backupWarningBanner}
        {errorBanner}
        <TokenDisplay
          token={state.ecashToken}
          amountSats={state.amountSats}
          onClose={state.onClose}
        />
      </>
    );
  }

  if (state.currentView === "melt-confirm" && state.meltQuote) {
    return (
      <>
        {backupWarningBanner}
        {errorBanner}
        <MeltConfirmation
          amountSats={amountToNumber(state.meltQuote.amount)}
          feeSats={amountToNumber(state.meltQuote.fee_reserve)}
          invoice={state.lightningInput}
          isPaying={state.meltIsPaying}
          onConfirm={state.onConfirmMelt}
          onClose={state.onClose}
        />
      </>
    );
  }

  return (
    <>
      {backupWarningBanner}
      {errorBanner}
      <DepositWithdraw
        mode={state.mode}
        currentView={state.currentView as Parameters<typeof DepositWithdraw>[0]["currentView"]}
        mints={state.mints}
        selectedMintId={state.selectedMintId}
        amountSats={state.amountSats}
        amountLabel={state.amountLabel}
        selectedUnit={state.selectedUnit}
        unitOptions={state.unitOptions}
        amountFiat={state.amountFiat}
        fiatSymbol={state.fiatSymbol}
        showFiatPrimary={state.showFiatPrimary}
        lightningInput={state.lightningInput}
        onSelectMethod={state.onSelectMethod}
        onNumpadPress={state.onNumpadPress}
        onMintChange={state.onMintChange}
        onUnitChange={state.onUnitChange}
        onToggleCurrency={state.onToggleCurrency}
        onCreateInvoice={state.onCreateInvoice}
        onSendEcash={state.onSendEcash}
        onPaste={state.onPaste}
        onScan={state.onScan}
        onRequest={state.onRequest}
        onScanQR={state.onScanQR}
        onLightningInputChange={state.onLightningInputChange}
        onBack={state.onBack}
        onClose={state.onClose}
      />
    </>
  );
}
