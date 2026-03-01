import { ArrowLeft, Loader2, Check, AlertCircle } from 'lucide-react'
import type { WalletSetupProps } from '@/types/wallet-setup'
import { StepIndicator } from './StepIndicator'
import { WelcomeLanding } from './WelcomeLanding'
import { PwaConfirmation } from './PwaConfirmation'
import { ChoiceCards } from './ChoiceCards'
import { SeedDisplay } from './SeedDisplay'
import { SeedInput } from './SeedInput'
import { SeedVerification } from './SeedVerification'
import { MintSetup } from './MintSetup'

interface ExtendedWalletSetupProps extends WalletSetupProps {
  isPwa: boolean
  seedVerificationActive: boolean
  onVerificationComplete?: () => void
}

export function WalletSetup(props: ExtendedWalletSetupProps) {
  const {
    currentStep,
    showTerms,
    choice,
    seedWords,
    inputSeedWords,
    seedSaved,
    mintConnections,
    backgroundDataLoad,
    isPwa,
    seedVerificationActive,
    onWelcomeNext,
    onShowTerms,
    onCloseTerms,
    onPwaNext,
    onChoiceSelect,
    onSeedSavedToggle,
    onSeedWordInput,
    onSeedPhrasePaste,
    onRecover,
    onAddMint,
    onRemoveMint,
    onContinue,
    onBack,
    onFinishSetup,
    onVerificationComplete,
  } = props

  // Step 1: Welcome landing — full-screen standalone
  if (currentStep === 1) {
    return (
      <WelcomeLanding
        showTerms={showTerms}
        backgroundDataLoad={backgroundDataLoad}
        onWelcomeNext={onWelcomeNext}
        onShowTerms={onShowTerms}
        onCloseTerms={onCloseTerms}
      />
    )
  }

  // Step 2: PWA confirmation — full-screen standalone
  if (currentStep === 2) {
    return (
      <PwaConfirmation
        isPwa={isPwa}
        backgroundDataLoad={backgroundDataLoad}
        onPwaNext={onPwaNext}
        onBack={onBack}
      />
    )
  }

  // Steps 3-5: Wallet setup wizard with step indicator
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* Header */}
      <div className="w-full max-w-2xl mx-auto px-4 pt-8 pb-4">
        {/* Back button */}
        <div className="h-10 mb-4">
          {currentStep > 3 && !seedVerificationActive && (
            <button
              onClick={() => onBack?.()}
              className="flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" strokeWidth={1.5} />
              Back
            </button>
          )}
        </div>

        {/* Step indicator */}
        <StepIndicator currentStep={currentStep} />
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center px-4 py-8">
        {currentStep === 3 && (
          <ChoiceCards onChoiceSelect={onChoiceSelect} />
        )}

        {currentStep === 4 && choice === 'create' && !seedVerificationActive && (
          <SeedDisplay
            seedWords={seedWords}
            seedSaved={seedSaved}
            onSeedSavedToggle={onSeedSavedToggle}
            onContinue={onContinue}
          />
        )}

        {currentStep === 4 && choice === 'create' && seedVerificationActive && (
          <SeedVerification
            seedWords={seedWords}
            onVerificationComplete={() => onVerificationComplete?.()}
            onBack={() => onSeedSavedToggle?.(false)}
          />
        )}

        {currentStep === 4 && choice === 'recover' && (
          <SeedInput
            inputSeedWords={inputSeedWords}
            onSeedWordInput={onSeedWordInput}
            onSeedPhrasePaste={onSeedPhrasePaste}
            onRecover={onRecover}
          />
        )}

        {currentStep === 5 && (
          <MintSetup
            mintConnections={mintConnections}
            onAddMint={onAddMint}
            onRemoveMint={onRemoveMint}
            onFinishSetup={onFinishSetup}
          />
        )}
      </div>

      {/* Background data loading indicator (steps 3-4 only) */}
      {currentStep < 5 && backgroundDataLoad && backgroundDataLoad.status !== 'idle' && (
        <div className="fixed bottom-6 left-6 z-40">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white dark:bg-slate-800/80 backdrop-blur-sm border border-slate-200 dark:border-slate-700/50 text-xs shadow-sm">
            {backgroundDataLoad.status === 'loading' && (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-blue-500 dark:text-blue-400" />
                <span className="text-slate-500 dark:text-slate-400">Loading markets...</span>
              </>
            )}
            {backgroundDataLoad.status === 'loaded' && (
              <>
                <Check className="w-3 h-3 text-emerald-500 dark:text-emerald-400" strokeWidth={2.5} />
                <span className="text-slate-500 dark:text-slate-400">{backgroundDataLoad.conditionsLoaded} markets loaded</span>
              </>
            )}
            {backgroundDataLoad.status === 'failed' && (
              <>
                <AlertCircle className="w-3 h-3 text-amber-500 dark:text-amber-400" />
                <span className="text-slate-500 dark:text-slate-400">Failed to load markets</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
