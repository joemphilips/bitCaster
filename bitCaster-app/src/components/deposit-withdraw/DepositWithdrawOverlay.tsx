import type { ReactNode } from "react";
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
import { activeBrowserWalletScopeId } from "@/lib/browserWalletProfile";
import { useWalletStore } from "@/stores/wallet";
import { NativeDialog } from "@/components/shared/NativeDialog";

interface DepositWithdrawOverlayProps {
  mode: DepositWithdrawMode;
  onClose: () => void;
}

export function DepositWithdrawOverlay({ mode, onClose }: DepositWithdrawOverlayProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const state = useDepositWithdrawState(mode, onClose);
  const walletMnemonic = useWalletStore((s) => s.mnemonic);
  const walletSeedReminderAcknowledgedScopeId = useWalletStore(
    (s) => s.walletSeedReminderAcknowledgedScopeId,
  );
  const hasWalletSeed = walletMnemonic.trim().length > 0;
  const walletSeedReminderAcknowledged =
    walletSeedReminderAcknowledgedScopeId !== null &&
    walletSeedReminderAcknowledgedScopeId === activeBrowserWalletScopeId();
  const [backupWarningDismissed, setBackupWarningDismissed] = useState(false);
  const showBackupWarning =
    mode === "deposit" &&
    hasWalletSeed &&
    !walletSeedReminderAcknowledged &&
    !backupWarningDismissed;
  const canDismiss = state.currentView !== "melt-confirm" || !state.meltIsPaying;
  const dialog = (children: (dismiss: () => void) => ReactNode) => (
    <NativeDialog
      ariaLabel={mode === "deposit" ? t("deposit.title") : t("deposit.withdrawal")}
      canDismiss={canDismiss}
      onDismiss={state.onClose}
    >
      {children}
    </NativeDialog>
  );

  useEffect(() => {
    setBackupWarningDismissed(false);
  }, [mode, walletMnemonic]);

  const dismissBackupWarning = () => {
    setBackupWarningDismissed(true);
  };

  const fixedErrorBanner = state.error ? (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] bg-red-900/90 border border-red-700 text-red-200 text-sm px-4 py-2 rounded-xl max-w-sm text-center">
      {state.error}
    </div>
  ) : null;

  const statusMessage = state.error ? (
    <div
      data-testid="deposit-status-message"
      className="rounded-xl border border-red-700 bg-red-900/90 px-4 py-2 text-center text-sm text-red-200"
    >
      {state.error}
    </div>
  ) : null;

  const depositReminder = showBackupWarning ? (
    <div
      data-testid="deposit-seed-reminder"
      className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100"
    >
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
    return dialog((dismiss) => (
      <SuccessView
        amountMsat={state.successAmountMsat}
        baseAsset={state.successBaseAsset}
        amountLabel={formatAmount(state.successAmountMsat, state.successBaseAsset)}
        onClose={dismiss}
      />
    ));
  }

  if (state.currentView === "scanner") {
    return dialog(() => (
      <>
        {fixedErrorBanner}
        <QrScannerView onDecode={state.onScanResult} onClose={state.onBack} />
      </>
    ));
  }

  const paymentRequestEncoded = state.paymentRequestEncoded;
  if (state.currentView === "payment-request-display" && paymentRequestEncoded) {
    return dialog((dismiss) => (
      <>
        {fixedErrorBanner}
        <PaymentRequestDisplay
          paymentRequestEncoded={paymentRequestEncoded}
          status={state.paymentRequestStatus}
          amountSats={state.amountSats}
          onClose={dismiss}
        />
      </>
    ));
  }

  const bolt11 = state.bolt11;
  if (state.currentView === "invoice-display" && bolt11) {
    return dialog((dismiss) => (
      <>
        {fixedErrorBanner}
        <InvoiceDisplay
          bolt11={bolt11}
          amountSats={state.amountSats}
          amountLabel={state.amountLabel}
          status={state.invoiceStatus}
          expiresAtSec={state.invoiceExpiresAtSec}
          errorMessage={state.error}
          onClose={dismiss}
          onRegenerate={state.onRegenerateInvoice}
        />
      </>
    ));
  }

  const bearerWithdrawal = state.bearerWithdrawal;
  const ecashToken = state.ecashToken;
  const bearerToken = bearerWithdrawal?.token;
  if (state.currentView === "token-display" && ecashToken && bearerToken) {
    return dialog((dismiss) => (
      <>
        {fixedErrorBanner}
        <TokenDisplay
          token={ecashToken}
          amountSats={state.amountSats}
          proofCount={bearerToken.proofs.length}
          onClose={dismiss}
          onReclaim={state.onReclaimEcash}
        />
      </>
    ));
  }

  const meltQuote = state.meltQuote;
  if (state.currentView === "melt-confirm" && meltQuote) {
    return dialog((dismiss) => (
      <>
        {fixedErrorBanner}
        <MeltConfirmation
          amountSats={amountToNumber(meltQuote.amount) / 1_000}
          feeSats={amountToNumber(meltQuote.fee_reserve) / 1_000}
          invoice={state.lightningInput}
          isPaying={state.meltIsPaying}
          onConfirm={state.onConfirmMelt}
          onClose={dismiss}
        />
      </>
    ));
  }

  return dialog((dismiss) => (
    <>
      <DepositWithdraw
        mode={state.mode}
        currentView={state.currentView as Parameters<typeof DepositWithdraw>[0]["currentView"]}
        depositReminder={depositReminder}
        statusMessage={statusMessage}
        mints={state.mints}
        selectedMintId={state.selectedMintId}
        amountSats={state.amountSats}
        amountLabel={state.amountLabel}
        amountFiat={state.amountFiat}
        fiatSymbol={state.fiatSymbol}
        showFiatPrimary={state.showFiatPrimary}
        lightningInput={state.lightningInput}
        onSelectMethod={state.onSelectMethod}
        onNumpadPress={state.onNumpadPress}
        onMintChange={state.onMintChange}
        onToggleCurrency={state.onToggleCurrency}
        onCreateInvoice={state.onCreateInvoice}
        onSendEcash={state.onSendEcash}
        onReclaimEcash={state.onReclaimEcash}
        hasPendingBearerReclaim={
          state.bearerWithdrawal?.deliveryState === "bearer-partial" ||
          state.bearerWithdrawal?.deliveryState === "reclaim-prepared"
        }
        onPaste={state.onPaste}
        onScan={state.onScan}
        onRequest={state.onRequest}
        onScanQR={state.onScanQR}
        onLightningInputChange={state.onLightningInputChange}
        onBack={state.onBack}
        onClose={dismiss}
      />
    </>
  ));
}
