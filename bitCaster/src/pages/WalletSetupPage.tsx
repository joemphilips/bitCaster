import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { WalletSetup } from '@/components/wallet-setup/WalletSetup'
import { NowLoadingPage } from '@/components/wallet-setup/NowLoadingPage'
import { useWalletStore } from '@/stores/wallet'
import { fetchConditions } from '@/lib/markets'
import * as bip39Lib from '@/lib/bip39'
import type { SetupStep, SetupChoice, MintConnectionTest, BackgroundDataLoad } from '@/types/wallet-setup'

export function WalletSetupPage() {
  const navigate = useNavigate()

  // Local UI state
  const [currentStep, setCurrentStep] = useState<SetupStep>(1)
  const [showTerms, setShowTerms] = useState(false)
  const [choice, setChoice] = useState<SetupChoice | null>(null)
  const [seedSaved, setSeedSaved] = useState(false)
  const [seedVerificationActive, setSeedVerificationActive] = useState(false)
  const [inputSeedWords, setInputSeedWords] = useState(Array(12).fill(''))
  const [mintConnections, setMintConnections] = useState<MintConnectionTest[]>([])

  // Store state
  const mnemonic = useWalletStore((s) => s.mnemonic)
  const generateMnemonic = useWalletStore((s) => s.generateMnemonic)
  const recoverFromMnemonic = useWalletStore((s) => s.recoverFromMnemonic)
  const addMint = useWalletStore((s) => s.addMint)
  const removeMint = useWalletStore((s) => s.removeMint)
  const completeSetup = useWalletStore((s) => s.completeSetup)

  const seedWords = mnemonic ? mnemonic.split(' ') : []

  // PWA detection
  const [isPwa, setIsPwa] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    setIsPwa(mq.matches || (navigator as unknown as { standalone?: boolean }).standalone === true)
    const handler = (e: MediaQueryListEvent) => setIsPwa(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Background market data loading
  const [marketDataLoaded, setMarketDataLoaded] = useState(false)
  const [backgroundDataLoad, setBackgroundDataLoad] = useState<BackgroundDataLoad>({
    mintUrl: '',
    status: 'idle',
    conditionsLoaded: 0,
  })
  const marketDataFetchStarted = useRef(false)

  useEffect(() => {
    if (currentStep >= 3 && !marketDataLoaded && !marketDataFetchStarted.current) {
      marketDataFetchStarted.current = true
      setBackgroundDataLoad((prev) => ({ ...prev, status: 'loading' }))
      fetchConditions()
        .then((conditions) => {
          setMarketDataLoaded(true)
          setBackgroundDataLoad((prev) => ({
            ...prev,
            status: 'loaded',
            conditionsLoaded: conditions.length,
          }))
        })
        .catch(() => {
          setMarketDataLoaded(true)
          setBackgroundDataLoad((prev) => ({ ...prev, status: 'failed' }))
        })
    }
  }, [currentStep, marketDataLoaded])

  // "Now Loading" transition page
  const [showLoadingPage, setShowLoadingPage] = useState(false)

  useEffect(() => {
    if (showLoadingPage && marketDataLoaded) {
      navigate('/markets')
    }
  }, [showLoadingPage, marketDataLoaded, navigate])

  // Auto-add default mint on step 5 entry
  const mintAutoAdded = useRef(false)
  useEffect(() => {
    if (currentStep === 5 && mintConnections.length === 0 && !mintAutoAdded.current) {
      mintAutoAdded.current = true
      const defaultUrl = import.meta.env.VITE_MINT_URL ?? 'http://localhost:3338'
      handleAddMint(defaultUrl)
    }
  }, [currentStep, mintConnections.length])

  // --- Callbacks ---

  const onChoiceSelect = (c: SetupChoice) => {
    setChoice(c)
    if (c === 'create') {
      generateMnemonic()
    }
    setCurrentStep(4)
  }

  const onSeedSavedToggle = (saved: boolean) => {
    setSeedSaved(saved)
    if (saved) {
      setSeedVerificationActive(true)
    } else {
      setSeedVerificationActive(false)
    }
  }

  const onVerificationComplete = () => {
    setCurrentStep(5)
  }

  const onSeedWordInput = (index: number, word: string) => {
    setInputSeedWords((prev) => {
      const next = [...prev]
      next[index] = word
      return next
    })
  }

  const onSeedPhrasePaste = (phrase: string) => {
    const words = phrase.trim().split(/[\s,]+/)
    setInputSeedWords(words.slice(0, 12))
  }

  const onRecover = () => {
    const words = inputSeedWords.map((w) => w.trim())
    if (!bip39Lib.validate(words)) return
    recoverFromMnemonic(words)
    setCurrentStep(5)
  }

  const handleAddMint = async (url: string) => {
    setMintConnections((prev) => [...prev, { url, status: 'connecting' }])
    try {
      await addMint(url)
      setMintConnections((prev) =>
        prev.map((m) => (m.url === url ? { ...m, status: 'connected' } : m))
      )
    } catch (e) {
      setMintConnections((prev) =>
        prev.map((m) =>
          m.url === url ? { ...m, status: 'failed', errorMessage: String(e) } : m
        )
      )
    }
  }

  const onRemoveMintHandler = (url: string) => {
    if (mintConnections.length <= 1) return
    removeMint(url)
    setMintConnections((prev) => prev.filter((m) => m.url !== url))
  }

  const onFinishSetup = () => {
    completeSetup()
    if (marketDataLoaded) {
      navigate('/markets')
    } else {
      setShowLoadingPage(true)
    }
  }

  const onBack = () => {
    if (currentStep === 4 && seedVerificationActive) {
      setSeedVerificationActive(false)
      return
    }
    if (currentStep > 1) {
      setCurrentStep((s) => (s - 1) as SetupStep)
    }
  }

  if (showLoadingPage) {
    return <NowLoadingPage />
  }

  return (
    <WalletSetup
      currentStep={currentStep}
      showTerms={showTerms}
      choice={choice}
      seedWords={seedWords}
      inputSeedWords={inputSeedWords}
      seedSaved={seedSaved}
      mintConnections={mintConnections}
      backgroundDataLoad={backgroundDataLoad}
      isPwa={isPwa}
      seedVerificationActive={seedVerificationActive}
      onWelcomeNext={() => setCurrentStep(2)}
      onShowTerms={() => setShowTerms(true)}
      onCloseTerms={() => setShowTerms(false)}
      onPwaNext={() => setCurrentStep(3)}
      onChoiceSelect={onChoiceSelect}
      onSeedSavedToggle={onSeedSavedToggle}
      onSeedWordInput={onSeedWordInput}
      onSeedPhrasePaste={onSeedPhrasePaste}
      onRecover={onRecover}
      onAddMint={handleAddMint}
      onRemoveMint={onRemoveMintHandler}
      onContinue={onVerificationComplete}
      onBack={onBack}
      onFinishSetup={onFinishSetup}
      onVerificationComplete={onVerificationComplete}
    />
  )
}
