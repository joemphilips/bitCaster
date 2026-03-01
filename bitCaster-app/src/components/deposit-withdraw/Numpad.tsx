import { ChevronLeft } from 'lucide-react'

interface NumpadProps {
  onPress?: (key: string) => void
}

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'backspace'],
]

export function Numpad({ onPress }: NumpadProps) {
  return (
    <div className="grid grid-cols-3 gap-1 px-8">
      {KEYS.flat().map((key, i) => {
        if (key === '') {
          return <div key={i} />
        }

        if (key === 'backspace') {
          return (
            <button
              key={i}
              onClick={() => onPress?.('backspace')}
              className="flex items-center justify-center h-14 rounded-lg text-white hover:bg-slate-800 active:bg-slate-700 transition-colors"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )
        }

        return (
          <button
            key={i}
            onClick={() => onPress?.(key)}
            className="flex items-center justify-center h-14 rounded-lg text-xl font-semibold text-white hover:bg-slate-800 active:bg-slate-700 transition-colors"
          >
            {key}
          </button>
        )
      })}
    </div>
  )
}
