import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  className?: string
}

export function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open) {
      el.showModal()
    } else {
      el.close()
    }
  }, [open])

  function handleCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault()
    onOpenChange(false)
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === ref.current) onOpenChange(false)
  }

  const dialogEl = (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      onClick={handleBackdropClick}
      style={{ background: 'transparent', border: 'none', padding: 0, maxWidth: 'none', maxHeight: 'none' }}
      className={cn(
        'fixed inset-0 z-[9999] m-auto flex items-center justify-center outline-none',
        '[&::backdrop]:bg-black/50 [&::backdrop]:backdrop-blur-sm',
        className
      )}
    >
      {children}
    </dialog>
  )

  return open ? createPortal(dialogEl, document.body) : null
}

interface DialogContentProps {
  children: React.ReactNode
  className?: string
}

export function DialogContent({ children, className }: DialogContentProps) {
  return (
    <div
      role="document"
      className={cn(
        'relative z-10 w-full overflow-y-auto pointer-events-auto bg-card',
        'h-full md:h-auto md:max-h-[90vh] md:max-w-2xl md:rounded-2xl',
        'max-md:max-h-dvh',
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
