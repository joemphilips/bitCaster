import { useEffect } from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatBtc } from '@/lib/format'

interface SuccessViewProps {
  amountSats: number
  onClose: () => void
}

export function SuccessView({ amountSats, onClose }: SuccessViewProps) {
  const { t } = useTranslation()

  useEffect(() => {
    const timer = setTimeout(onClose, 3000)
    return () => clearTimeout(timer)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 flex flex-col items-center justify-center">
      <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mb-6">
        <Check className="w-10 h-10 text-emerald-400" />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2">
        {t('common.success')}
      </h2>
      {amountSats > 0 && (
        <p className="text-lg font-mono text-emerald-400">
          {formatBtc(amountSats)}
        </p>
      )}
      <p className="text-sm text-slate-400 mt-4">
        {t('deposit.autoClose')}
      </p>
    </div>
  )
}
