import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

export interface CopyCommandProps {
  /** The shell command, shown as-is in a well and copied by the button. */
  command: string
  /** What the command is for, read by screen readers on the button ("Copy the install command"). */
  label?: string
  className?: string
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers or a non-secure origin: select a hidden textarea and copy that.
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * A terminal command in a sunken well with a Copy button that says "Copied" for a moment
 * (announced politely to screen readers). Long commands scroll sideways instead of wrapping, so
 * what you see is exactly what you paste.
 */
export function CopyCommand({ command, label = 'Copy command', className = '' }: CopyCommandProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onCopy = async (): Promise<void> => {
    const ok = await copyText(command)
    setState(ok ? 'copied' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 2000)
  }

  return (
    <div
      className={`flex min-w-0 items-stretch overflow-hidden rounded-lg border border-hairline bg-sunken ${className}`}
    >
      <pre className="min-w-0 flex-1 overflow-x-auto px-4 py-3 font-mono text-small leading-6 text-ink">
        <code>
          <span aria-hidden className="text-ink-3 select-none">
            ${' '}
          </span>
          {command}
        </code>
      </pre>
      <button
        type="button"
        onClick={onCopy}
        aria-label={label}
        className="inline-flex shrink-0 items-center gap-1.5 border-l border-hairline px-3.5 text-small font-medium text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
      >
        {state === 'copied' ? <Check size={15} aria-hidden className="text-ok" /> : <Copy size={15} aria-hidden />}
        <span className="hidden sm:inline">
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied'
          ? 'Copied to the clipboard'
          : state === 'failed'
            ? 'Could not copy. Select the command and copy it.'
            : ''}
      </span>
    </div>
  )
}
