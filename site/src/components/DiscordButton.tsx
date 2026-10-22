import { DiscordMark } from './PlatformMarks'
import { DISCORD_URL } from './Layout'

/**
 * "Join the Discord", in Discord's blurple with its mark. `size="lg"` matches the download button's
 * height, to sit beside it.
 */
export function DiscordButton({ size = 'md', className = '' }: { size?: 'md' | 'lg'; className?: string }) {
  const sizing = size === 'lg' ? 'h-14 gap-3 rounded-xl px-6 text-[1.0625rem]' : 'h-11 gap-2.5 rounded-lg px-5 text-[0.9375rem]'
  return (
    <a
      href={DISCORD_URL}
      className={`inline-flex items-center font-semibold text-white no-underline shadow-[0_8px_24px_-8px_rgb(88_101_242/0.6)] transition-colors duration-100 bg-[#5865f2] hover:bg-[#4752c4] ${sizing} ${className}`}
    >
      <DiscordMark className={size === 'lg' ? 'size-5' : 'size-[18px]'} />
      Join the Discord
    </a>
  )
}
