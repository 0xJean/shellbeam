import { useEffect, useImperativeHandle, useRef, type ComponentProps } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Keep native form and keyboard behavior with ShellBeam's own visual styling. */
export function Checkbox({ className, ref, indeterminate = false, ...props }: Omit<ComponentProps<'input'>, 'type'> & { indeterminate?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => inputRef.current!, [])
  useEffect(() => { if (inputRef.current) inputRef.current.indeterminate = indeterminate }, [indeterminate])
  return <span className="relative inline-flex shrink-0 align-middle">
    <input {...props} ref={inputRef} type="checkbox" aria-checked={indeterminate ? 'mixed' : props['aria-checked']} className={cn('peer h-4 w-4 shrink-0 cursor-pointer appearance-none rounded border border-input bg-background transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50', className)} />
    {indeterminate ? <Minus aria-hidden="true" className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-white" /> : <Check aria-hidden="true" className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-white opacity-0 peer-checked:opacity-100" />}
  </span>
}
