/**
 * Settings → OCR & Overlay → Filter out furigana and small text: the switch, and behind a
 * disclosure beside it the filter's strength as five named steps on a full-width bar, with what
 * the chosen step removes written under it.
 *
 * The stored setting is still `textOverlayGrouping.filterSmallTextThreshold`, the share of the
 * capture's median text height below which text is dropped (`filterSmallTextAnnotations` in
 * ui/annotations.ts): a higher share removes more. A value saved by the old percentage slider
 * shows on its nearest step and is only rewritten when a step is chosen.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { IconButton, SettingsRow, SettingsSubgroup, Slider, Switch, cn } from '@kit'
import { FILTER_LEVELS, filterLevelOf } from '@ui/annotations'
import './small-text-filter.css'

export function SmallTextFilter({
  enabled,
  threshold,
  onEnabledChange,
  onThresholdChange
}: {
  enabled: boolean
  threshold: number
  onEnabledChange: (enabled: boolean) => void
  onThresholdChange: (threshold: number) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const level = filterLevelOf(threshold)
  const choose = (index: number): void => {
    if (index !== level) onThresholdChange(FILTER_LEVELS[index].threshold)
  }
  const shown = enabled && open
  return (
    <>
      <SettingsRow
        label="Filter out furigana and small text"
        controlId="ocr-filter-small"
        description="Removes text much smaller than the main text, such as reading aids above kanji."
      >
        {enabled && (
          <IconButton
            label={open ? 'Hide filter strength' : 'Filter strength'}
            size="sm"
            className={cn('small-text-filter-disclosure', open && 'small-text-filter-disclosure-open')}
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown />
          </IconButton>
        )}
        <Switch id="ocr-filter-small" checked={enabled} onCheckedChange={onEnabledChange} />
      </SettingsRow>
      {shown && (
        <SettingsSubgroup>
          <div id={panel} className="small-text-filter">
            <Slider
              aria-label="Filter strength"
              valueText={(index) => FILTER_LEVELS[index].label}
              value={[level]}
              onValueChange={(values) => choose(values[0])}
              min={0}
              max={FILTER_LEVELS.length - 1}
              step={1}
            />
            <div className="small-text-filter-steps" aria-hidden>
              {FILTER_LEVELS.map((step, index) => (
                <button
                  key={step.label}
                  type="button"
                  tabIndex={-1}
                  className="small-text-filter-step"
                  data-active={index === level || undefined}
                  onClick={() => choose(index)}
                >
                  {step.label}
                </button>
              ))}
            </div>
            <p className="small-text-filter-description" aria-live="polite">
              {FILTER_LEVELS[level].description}
            </p>
          </div>
        </SettingsSubgroup>
      )}
    </>
  )
}
