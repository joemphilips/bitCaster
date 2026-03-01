import { Loader2 } from 'lucide-react'

export function NowLoadingPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6 text-center">
      <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-8" />
      <p className="text-lg sm:text-xl font-medium text-slate-300 max-w-md leading-relaxed">
        Finance wants to be free | Fake must be expensive
      </p>
    </div>
  )
}
