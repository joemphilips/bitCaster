import { SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HorizontalPager } from "@/components/common/HorizontalPager";
import type { CategoryTag } from "@/types/market";

interface TagBarProps {
  categoryTags: CategoryTag[];
  /**
   * Currently selected category tag IDs (multi-select, OR semantics). The
   * engine's `/api/v1/markets/query?tag=…` accepts repeated values; the page
   * forwards the whole set per click. P7 §`/markets`: users want to combine
   * categories rather than cycle through them one at a time.
   */
  selectedTags: string[];
  filtersVisible: boolean;
  activeFilterCount: number;
  onTagSelect?: (tagId: string) => void;
  onClearTags?: () => void;
  onToggleFilters?: () => void;
  /**
   * When the bar is composed alongside a sort row (Issue 5.1) the host
   * supplies its own background; we drop the inner wrapper so the row
   * presents as one continuous strip.
   */
  embedded?: boolean;
}

export function TagBar({
  categoryTags,
  selectedTags,
  filtersVisible,
  activeFilterCount,
  onTagSelect,
  onClearTags,
  onToggleFilters,
  embedded = false,
}: TagBarProps) {
  const { t } = useTranslation();
  const selectedSet = new Set(selectedTags);
  const hasAnySelected = selectedSet.size > 0;

  // When embedded the host (`MarketDiscovery`) supplies the row padding;
  // otherwise this row is the standalone bar and owns its own padding.
  const padClass = embedded ? "" : "px-4 sm:px-6 lg:px-8 py-3";
  const chips = (
    <HorizontalPager
      className={`items-center gap-2 ${padClass}`}
      scrollerTestId="market-tag-scroller"
    >
      {categoryTags.map((tag) => (
        <CategoryChip
          key={tag.id}
          tag={tag}
          isSelected={selectedSet.has(tag.id)}
          onSelect={() => onTagSelect?.(tag.id)}
        />
      ))}

      {hasAnySelected && <ClearAllChip onClick={onClearTags} label={t("common.clearAll")} />}

      <div className="w-px bg-slate-300 dark:bg-slate-700 mx-2 self-stretch" />
      <FilterToggleButton
        active={filtersVisible}
        count={activeFilterCount}
        onClick={onToggleFilters}
      />
    </HorizontalPager>
  );

  if (embedded) {
    return (
      <div data-testid="market-tag-bar" className="min-w-0 flex-1">
        {chips}
      </div>
    );
  }

  return (
    <div data-testid="market-tag-bar" className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md">
      {chips}
    </div>
  );
}

interface CategoryChipProps {
  tag: CategoryTag;
  isSelected: boolean;
  onSelect: () => void;
}

function CategoryChip({ tag, isSelected, onSelect }: CategoryChipProps) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={isSelected}
      className={`px-4 py-2 rounded-full font-semibold text-sm transition-all transform hover:scale-105 whitespace-nowrap ${
        isSelected
          ? "bg-blue-600 dark:bg-blue-500 text-white shadow-lg scale-105"
          : "bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700"
      }`}
    >
      <span>{tag.label}</span>
      <span className="ml-2 text-xs opacity-75 font-mono">{tag.marketCount}</span>
    </button>
  );
}

function ClearAllChip({ onClick, label }: { onClick?: () => void; label: string }) {
  // Surfaces only while at least one tag is active so the row stays calm at
  // rest. The mobile bottom-nav and the desktop header both render this
  // row, so the affordance is present in both layouts.
  return (
    <button
      onClick={onClick}
      data-testid="market-tag-clear"
      className="flex items-center gap-1 px-3 py-2 rounded-full font-semibold text-sm transition-colors whitespace-nowrap bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 hover:bg-rose-200 dark:hover:bg-rose-900/50"
    >
      <X className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );
}

interface FilterToggleButtonProps {
  active: boolean;
  count: number;
  onClick?: () => void;
}

function FilterToggleButton({ active, count, onClick }: FilterToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`relative p-2 rounded-full transition-all transform hover:scale-105 ${
        active
          ? "bg-blue-600 dark:bg-blue-500 text-white shadow-lg"
          : "bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700"
      }`}
      title={active ? "Hide filters" : "Show filters"}
    >
      <SlidersHorizontal className="w-4 h-4" />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
          {count}
        </span>
      )}
    </button>
  );
}
