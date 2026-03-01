import type { DepositWithdrawMode } from '@/types/deposit-withdraw'
import { useDepositWithdrawState } from '@/pages/useDepositWithdrawState'
import { DepositWithdraw } from './DepositWithdraw'
import { InvoiceDisplay } from './InvoiceDisplay'
import { TokenDisplay } from './TokenDisplay'
import { MeltConfirmation } from './MeltConfirmation'

interface DepositWithdrawOverlayProps {
  mode: DepositWithdrawMode
  onClose: () => void
}

export function DepositWithdrawOverlay({ mode, onClose }: DepositWithdrawOverlayProps) {
  const state = useDepositWithdrawState(mode, onClose)

  // Error toast
  const errorBanner = state.error ? (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] bg-red-900/90 border border-red-700 text-red-200 text-sm px-4 py-2 rounded-xl max-w-sm text-center">
      {state.error}
    </div>
  ) : null

  if (state.currentView === 'invoice-display' && state.bolt11) {
    return (
      <>
        {errorBanner}
        <InvoiceDisplay
          bolt11={state.bolt11}
          amountSats={state.amountSats}
          status={state.invoiceStatus}
          onClose={state.onClose}
        />
      </>
    )
  }

  if (state.currentView === 'token-display' && state.ecashToken) {
    return (
      <>
        {errorBanner}
        <TokenDisplay
          token={state.ecashToken}
          amountSats={state.amountSats}
          onClose={state.onClose}
        />
      </>
    )
  }

  if (state.currentView === 'melt-confirm' && state.meltQuote) {
    return (
      <>
        {errorBanner}
        <MeltConfirmation
          amountSats={state.meltQuote.amount}
          feeSats={state.meltQuote.fee_reserve}
          invoice={state.lightningInput}
          isPaying={state.meltIsPaying}
          onConfirm={state.onConfirmMelt}
          onClose={state.onClose}
        />
      </>
    )
  }

  return (
    <>
      {errorBanner}
      <DepositWithdraw
        mode={state.mode}
        currentView={state.currentView as Parameters<typeof DepositWithdraw>[0]['currentView']}
        mints={state.mints}
        selectedMintId={state.selectedMintId}
        amountSats={state.amountSats}
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
        onPaste={state.onPaste}
        onScan={state.onScan}
        onRequest={state.onRequest}
        onScanQR={state.onScanQR}
        onLightningInputChange={state.onLightningInputChange}
        onBack={state.onBack}
        onClose={state.onClose}
      />
    </>
  )
}
