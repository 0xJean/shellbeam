import { cn } from '@/lib/utils'
import * as React from 'react'
import { createPortal } from 'react-dom'

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
      style={{ background: 'transparent', border: 'none', padding: 0, maxWidth: 'none', maxHeight: 'none', width: '100%', height: '100%' }}
      className={cn(
        'fixed inset-0 z-[9999] m-0 flex items-start justify-center overflow-y-auto outline-none md:items-center',
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
        'relative z-10 overflow-y-auto pointer-events-auto bg-card text-card-foreground',
        'md:mx-auto md:h-auto md:max-h-[90vh] md:w-auto md:max-w-2xl md:rounded-2xl',
        'max-md:w-full max-md:min-h-full',
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
