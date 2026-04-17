import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function NowLoadingPage() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6 text-center">
      <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-8" />
      <p className="text-lg sm:text-xl font-medium text-slate-300 max-w-md leading-relaxed">
        {t('loading.tagline')}
      </p>
    </div>
  )
}
