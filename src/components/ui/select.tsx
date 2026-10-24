import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  icon?: React.ReactNode
  description?: React.ReactNode
  disabled?: boolean
}

type NativeSelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> & {
  /** Extra presentation for options; the real select retains form/change semantics. */
  optionDetails?: SelectOption[]
}

function readOptions(children: React.ReactNode, disabled = false): SelectOption[] {
  return React.Children.toArray(children).flatMap(child => {
    if (!React.isValidElement<{ value?: string | number; children?: React.ReactNode; disabled?: boolean; label?: string }>(child)) return []
    if (child.type !== 'option') return readOptions(child.props.children, disabled || !!child.props.disabled)
    const label = child.props.label ?? React.Children.toArray(child.props.children).join('')
    return [{ value: String(child.props.value ?? label), label, disabled: disabled || child.props.disabled }]
  })
}

/** An application-styled menu over a real select. Keep native value, label,
 * form and change events, but never open the platform-specific popup.
 * Truncate the trigger: WebKit can otherwise paint a long selected label past
 * its bounded box and introduce a horizontal scrollbar in its parent dialog.
 * The application menu still shows the complete, wrapping option label. */
export function NativeSelect({ children, className, optionDetails, disabled, onClick, onPointerDown, onMouseDown, onKeyDown, onChange, ...props }: NativeSelectProps) {
  const { t } = useT()
  const id = React.useId()
  const triggerRef = React.useRef<HTMLSelectElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const options = readOptions(children).map(option => ({ ...option, ...optionDetails?.find(detail => detail.value === option.value) }))
  const [open, setOpen] = React.useState(false)
  const [uncontrolledValue, setUncontrolledValue] = React.useState(String(props.defaultValue ?? options.find(option => !option.disabled)?.value ?? ''))
  const selectedValue = String(props.value ?? uncontrolledValue)
  const [active, setActive] = React.useState(-1)
  const [position, setPosition] = React.useState<React.CSSProperties>({ top: 0, left: 0, width: 0, maxHeight: 240 })
  const [portalRoot, setPortalRoot] = React.useState<HTMLElement | null>(null)
  const search = React.useRef({ text: '', at: 0 })
  const expanded = open && !disabled

  function show(last = false) {
    if (disabled) return
    setUncontrolledValue(triggerRef.current?.value ?? '')
    const selected = options.findIndex(option => option.value === triggerRef.current?.value && !option.disabled)
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
    setActive(selected >= 0 ? selected : (last ? enabled.at(-1) : enabled[0]) ?? -1)
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    const select = triggerRef.current
    if (!select || disabled || !option || option.disabled) return
    setOpen(false)
    select.focus({ preventScroll: true })
    if (select.value !== option.value) {
      select.value = option.value
      // Dispatch on the real field so existing handlers receive the original
      // HTMLSelectElement, and controlled action menus reset normally.
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  React.useLayoutEffect(() => {
    if (!expanded) return
    const select = triggerRef.current!
    // A portal on body is inert/behind a modal dialog's top layer.
    setPortalRoot(select.closest('dialog') ?? document.body)
    const update = () => {
      const rect = select.getBoundingClientRect()
      const viewport = window.visualViewport
      const top = viewport?.offsetTop ?? 0
      const left = viewport?.offsetLeft ?? 0
      const height = viewport?.height ?? window.innerHeight
      const width = viewport?.width ?? window.innerWidth
      // Native focus/scroll can move the trigger outside the viewport while a
      // portal is open. Clamp its anchor as well as its width: negative bottom
      // offsets otherwise place the entire listbox below a long page.
      const anchorTop = Math.max(top + 8, Math.min(rect.top, top + height - 8))
      const anchorBottom = Math.max(top + 8, Math.min(rect.bottom, top + height - 8))
      const below = Math.max(0, top + height - anchorBottom - 12)
      const above = Math.max(0, anchorTop - top - 12)
      const goUp = below < Math.min(options.length * 36 + 8, 240) && above > below
      const menuHeight = Math.max(0, Math.min(240, goUp ? above : below))
      const menuWidth = Math.max(0, Math.min(Math.max(rect.width, 208), width - 16))
      setPosition({ top: goUp ? undefined : anchorBottom + 4, bottom: goUp ? window.innerHeight - anchorTop + 4 : undefined,
        left: Math.max(left + 8, Math.min(rect.left, left + width - menuWidth - 8)), width: menuWidth, maxHeight: menuHeight })
    }
    update()
    const dismiss = (event: Event) => {
      const target = event.target as Node
      if (!select.contains(target) && !listRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('focusin', dismiss)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [expanded, options.length])

  React.useLayoutEffect(() => {
    const list = listRef.current
    const option = list?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)
    if (!expanded || !list || !option) return
    // Reveal inside the menu only. scrollIntoView also scrolls its document
    // ancestors in WebKit, moving the trigger and portal during selection.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight
    }
  }, [active, expanded, portalRoot, position.maxHeight])

  function keyDown(event: React.KeyboardEvent<HTMLSelectElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || disabled) return
    event.stopPropagation()
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'Escape') { if (expanded) event.preventDefault(); setOpen(false); return }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (expanded) choose(active); else show()
      return
    }
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!expanded) show(event.key === 'ArrowUp' || event.key === 'End')
      else {
        const current = enabled.indexOf(active)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length
        setActive(enabled[next] ?? -1)
      }
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const text = (Date.now() - search.current.at < 700 ? search.current.text : '') + event.key.toLocaleLowerCase()
      search.current = { text, at: Date.now() }
      const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(text))
      if (match >= 0) { setOpen(true); setActive(match) }
    }
  }

  return <>
    <select {...props} ref={triggerRef} disabled={disabled} aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      aria-activedescendant={expanded && active >= 0 ? `${id}-${active}` : undefined} data-app-select="true"
      className={cn('app-select h-9 min-w-0 max-w-full truncate rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] pl-3 text-sm font-medium text-[var(--workspace-text-muted)] transition-colors hover:text-[var(--workspace-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', className)}
      onPointerDown={event => { onPointerDown?.(event); event.preventDefault() }}
      onMouseDown={event => { onMouseDown?.(event); event.preventDefault() }}
      onClick={event => { onClick?.(event); event.preventDefault(); event.stopPropagation(); triggerRef.current?.focus({ preventScroll: true }); if (expanded) setOpen(false); else show() }}
      onKeyDown={keyDown} onChange={event => { setOpen(false); setUncontrolledValue(event.target.value); onChange?.(event) }}>
      {children}
    </select>
    {expanded && portalRoot && createPortal(<div ref={listRef} id={id} role="listbox" aria-label={props['aria-label'] ?? t('common.select')}
      className="fixed z-[10000] overflow-y-auto overscroll-contain rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1 shadow-xl"
      style={position} onPointerDown={event => event.preventDefault()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === selectedValue} aria-disabled={option.disabled || undefined}
        data-option-index={index} data-value={option.value} onMouseMove={() => { if (!option.disabled) setActive(index) }} onClick={() => choose(index)}
        className={cn('flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--workspace-text)]',
          index === active && 'bg-[var(--workspace-surface-700)]', option.value === selectedValue && 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-text-strong)]', option.disabled && 'cursor-not-allowed opacity-40')}>
        {option.icon}<span className="min-w-0 flex-1 break-words text-left"><span>{option.label}</span>{option.description && <span className="mt-0.5 block text-xs text-[var(--workspace-text-muted)]">{option.description}</span>}</span>
        {option.value === selectedValue && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-solid)]" />}
      </div>)}
      {options.length === 0 && <div className="px-3 py-3 text-center text-xs text-[var(--workspace-text-muted)]">{t('common.noOptions')}</div>}
    </div>, portalRoot)}
  </>
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
}

export function Select({ value, onChange, options, placeholder, className, disabled }: SelectProps) {
  const { t } = useT()
  return <div className={cn('relative', className)}><NativeSelect aria-label={placeholder ?? t('common.select')} value={value} onChange={event => onChange(event.target.value)} optionDetails={options} disabled={disabled} className="w-full">
    {!options.some(option => option.value === value) && <option value={value} disabled>{placeholder ?? t('common.select')}</option>}
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </NativeSelect></div>
}
