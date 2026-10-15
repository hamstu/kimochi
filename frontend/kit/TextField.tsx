import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'
import { useSteadyValue } from './ime'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = 'md', mono, value, onChange, ...props },
  ref
) {
  const steady = useSteadyValue(value, onChange)
  return (
    <input
      ref={ref}
      spellCheck={false}
      className={cn('k-field', size === 'sm' && 'k-field-sm', mono && 'k-field-mono', className)}
      {...props}
      {...steady}
    />
  )
})

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
>(function Textarea({ className, mono, value, onChange, ...props }, ref) {
  const steady = useSteadyValue(value, onChange)
  return (
    <textarea ref={ref} className={cn('k-field', mono && 'k-field-mono', className)} {...props} {...steady} />
  )
})
