import type { DepositWithdrawProps } from '@/types/deposit-withdraw'
import { MethodChooser } from './MethodChooser'
import { DepositEcash } from './DepositEcash'
import { DepositLightning } from './DepositLightning'
import { SendEcash } from './SendEcash'
import { PayLightning } from './PayLightning'

export function DepositWithdraw(props: DepositWithdrawProps) {
  const { currentView } = props

  switch (currentView) {
    case 'chooser':
      return (
        <MethodChooser
          mode={props.mode}
          onSelectMethod={props.onSelectMethod}
          onClose={props.onClose}
          onToggleFullscreen={props.onToggleFullscreen}
        />
      )

    case 'deposit-ecash':
      return (
        <DepositEcash
          onPaste={props.onPaste}
          onScan={props.onScan}
          onRequest={props.onRequest}
          onBack={props.onBack}
          onToggleFullscreen={props.onToggleFullscreen}
        />
      )

    case 'deposit-lightning':
      return (
        <DepositLightning
          mints={props.mints}
          selectedMintId={props.selectedMintId}
          amountSats={props.amountSats}
          amountFiat={props.amountFiat}
          fiatSymbol={props.fiatSymbol}
          showFiatPrimary={props.showFiatPrimary}
          onMintChange={props.onMintChange}
          onNumpadPress={props.onNumpadPress}
          onToggleCurrency={props.onToggleCurrency}
          onCreateInvoice={props.onCreateInvoice}
          onClose={props.onClose}
        />
      )

    case 'send-ecash':
      return (
        <SendEcash
          mints={props.mints}
          selectedMintId={props.selectedMintId}
          amountSats={props.amountSats}
          amountFiat={props.amountFiat}
          fiatSymbol={props.fiatSymbol}
          showFiatPrimary={props.showFiatPrimary}
          onMintChange={props.onMintChange}
          onNumpadPress={props.onNumpadPress}
          onToggleCurrency={props.onToggleCurrency}
          onSendEcash={props.onSendEcash}
          onClose={props.onClose}
        />
      )

    case 'pay-lightning':
      return (
        <PayLightning
          mints={props.mints}
          selectedMintId={props.selectedMintId}
          lightningInput={props.lightningInput}
          onMintChange={props.onMintChange}
          onLightningInputChange={props.onLightningInputChange}
          onPaste={props.onPaste}
          onScanQR={props.onScanQR}
          onClose={props.onClose}
        />
      )

    default:
      return null
  }
}
