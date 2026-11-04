import { DiscordMark } from './PlatformMarks'
import { DISCORD_URL } from './Layout'

/**
 * "Join the Discord" with Discord's mark.
 *
 * - `variant="primary"` (default): Discord's blurple, for where it is the call to action.
 * - `variant="secondary"`: the site's quiet field-ground button (see Button.tsx), for beside or
 *   under the download button, where it must not compete with it.
 *
 * `size="lg"` matches the download button's height, to sit beside it.
 */
export function DiscordButton({
  size = 'md',
  variant = 'primary',
  className = ''
}: {
  size?: 'md' | 'lg'
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  const sizing =
    size === 'lg' ? 'h-14 gap-3 rounded-xl px-6 text-[1.0625rem]' : 'h-11 gap-2.5 rounded-lg px-5 text-[0.9375rem]'
  const look =
    variant === 'secondary'
      ? 'group font-medium text-ink bg-field shadow-[inset_0_0_0_1px_var(--k-line-strong)] hover:bg-hover'
      : 'font-semibold text-white shadow-[0_8px_24px_-8px_rgb(88_101_242/0.6)] bg-[#5865f2] hover:bg-[#4752c4]'
  const mark = variant === 'secondary' ? (size === 'lg' ? 'size-6' : 'size-5') : size === 'lg' ? 'size-5' : 'size-[18px]'
  return (
    <a
      href={DISCORD_URL}
      className={`inline-flex items-center whitespace-nowrap no-underline transition-colors duration-100 ${look} ${sizing} ${className}`}
    >
      <DiscordMark
        className={
          variant === 'secondary' ? `${mark} text-ink-3 transition-colors duration-100 group-hover:text-ink-2` : mark
        }
      />
      Join the Discord
    </a>
  )
}
