import { useRef } from 'react'
import { Upload, X, Plus } from 'lucide-react'
import type { WizardStepBasicInfo } from '@/types/market-creation'
import { DateTimePicker } from '@/components/shared/DateTimePicker'

interface BasicInfoProps {
  data: WizardStepBasicInfo
  categoryTags: string[]
  onTitleChange?: (title: string) => void
  onCategoryTagsChange?: (tags: string[]) => void
  onClosingDateChange?: (date: string) => void
  onThumbnailUpload?: (file: File) => void
  onNext?: () => void
}

export function BasicInfo({
  data,
  categoryTags,
  onTitleChange,
  onCategoryTagsChange,
  onClosingDateChange,
  onThumbnailUpload,
  onNext,
}: BasicInfoProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const canProceed = data.title.trim().length > 0 && data.closingDate.length > 0 && new Date(data.closingDate) > new Date()

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onThumbnailUpload?.(file)
  }

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Basic Information</h2>
      <p className="text-sm text-slate-400 mb-8">
        Provide the core details for your prediction market.
      </p>

      <div className="space-y-6">
        {/* Thumbnail */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Thumbnail</label>
          <div className="flex items-center gap-4">
            <div className="w-28 h-28 rounded-lg border-2 border-dashed border-slate-700 bg-slate-900 flex flex-col items-center justify-center text-slate-500 overflow-hidden">
              {data.imageFile ? (
                <img src={data.imageFile} alt="Thumbnail preview" className="w-full h-full object-cover" />
              ) : (
                <>
                  <Plus className="w-6 h-6 mb-1" strokeWidth={1.5} />
                  <span className="text-xs">No image</span>
                </>
              )}
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
              >
                <Upload className="w-4 h-4 inline-block mr-1.5" strokeWidth={1.5} />
                Upload image
              </button>
              <p className="text-xs text-slate-500 mt-1.5">JPG/PNG/WEBP, max 5MB</p>
            </div>
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Title</label>
          <input
            type="text"
            value={data.title}
            onChange={(e) => onTitleChange?.(e.target.value)}
            placeholder="Type title..."
            className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
          />
          <p className="text-xs text-slate-500 mt-1.5">A clear question that the market resolves</p>
        </div>

        {/* Categories */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Categories</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {data.categoryTags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-blue-500/15 text-blue-400 text-xs font-medium"
              >
                {tag}
                <button
                  onClick={() => onCategoryTagsChange?.(data.categoryTags.filter((t) => t !== tag))}
                  className="hover:text-blue-200 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <select
            onChange={(e) => {
              if (e.target.value && !data.categoryTags.includes(e.target.value)) {
                onCategoryTagsChange?.([...data.categoryTags, e.target.value])
              }
              e.target.value = ''
            }}
            defaultValue=""
            className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
          >
            <option value="" disabled>Select...</option>
            {categoryTags.filter((t) => !data.categoryTags.includes(t)).map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1.5">Multiple selection. Choose relevant categories.</p>
        </div>

        {/* Closing Date */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">End Time</label>
          <DateTimePicker
            value={data.closingDate}
            onChange={(v) => onClosingDateChange?.(v)}
            min={new Date()}
            placeholder="Select date & time"
            aria-label="End Time"
          />
          <p className="text-xs text-slate-500 mt-1.5">When will this market stop accepting trades?</p>
        </div>
      </div>

      <button
        onClick={() => onNext?.()}
        disabled={!canProceed}
        className={`w-full py-3 rounded-full font-semibold text-sm transition-colors mt-8 ${
          canProceed
            ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25'
            : 'bg-slate-800 text-slate-500 cursor-not-allowed'
        }`}
      >
        Next
      </button>
    </div>
  )
}
