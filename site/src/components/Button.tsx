import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router'

export type ButtonVariant = 'primary' | 'secondary'
export type ButtonSize = 'md' | 'lg'

interface CommonProps {
  /** primary = the one indigo action on a surface; secondary = quiet field-ground button. */
  variant?: ButtonVariant
  /** md = 2.25rem tall (header, inline); lg = 2.75rem (hero, download). */
  size?: ButtonSize
  /** Optional leading icon, e.g. <Download size={16} aria-hidden />. */
  icon?: ReactNode
  className?: string
  children: ReactNode
}

type LinkButtonProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children'> & {
    /** Internal paths ("/compare", "/#demo") render a router Link; anything else an <a>. */
    href: string
  }

type NativeButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { href?: undefined }

export type ButtonProps = LinkButtonProps | NativeButtonProps

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium select-none ' +
  'transition-colors duration-100 ease-out-k no-underline ' +
  'disabled:opacity-50 disabled:pointer-events-none [&_svg]:shrink-0'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover',
  secondary: 'bg-field text-ink shadow-[inset_0_0_0_1px_var(--k-line-strong)] hover:bg-hover'
}

const sizes: Record<ButtonSize, string> = {
  md: 'h-9 px-3.5 text-small',
  lg: 'h-11 px-5 text-[0.9375rem]'
}

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra = ''): string {
  return [base, variants[variant], sizes[size], extra].filter(Boolean).join(' ')
}

export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md', icon, className = '', children, ...rest } = props
  const cls = buttonClass(variant, size, className)
  const content = (
    <>
      {icon}
      {children}
    </>
  )
  if (rest.href !== undefined) {
    const { href, ...anchor } = rest as LinkButtonProps
    if (href.startsWith('/') && !href.startsWith('//')) {
      return (
        <Link to={href} className={cls} {...anchor}>
          {content}
        </Link>
      )
    }
    return (
      <a href={href} className={cls} {...anchor}>
        {content}
      </a>
    )
  }
  const { type = 'button', ...button } = rest as NativeButtonProps
  return (
    <button type={type} className={cls} {...button}>
      {content}
    </button>
  )
}
