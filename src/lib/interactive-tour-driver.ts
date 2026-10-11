import { driver, type DriveStep, type Driver, type PopoverDOM } from 'driver.js'
import 'driver.js/dist/driver.css'
import '@/styles/interactive-tour.css'
import { findTourTarget, TOUR_READY, TOUR_STEPS, waitForTourTarget, type InteractiveTourId, type TourOutcome } from './interactive-tour'

interface TourOptions {
  id: InteractiveTourId
  t: (key: string) => string
  setHostFormOpen: (open: boolean) => void
  onWaiting: (waiting: boolean) => void
  onFinish: (outcome: TourOutcome) => void
}

export function startInteractiveTour(options: TourOptions) {
  const abort = new AbortController()
  const inertElements = new Map<HTMLElement, boolean>()
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let instance: Driver | undefined
  let activeTarget: HTMLElement | undefined
  let activeDialog: HTMLDialogElement | null = null
  let busy = false
  let stopped = false
  let index = 0
  let formOpen = false
  let overlayElement: Element | null = null
  let steps = [...TOUR_STEPS[options.id]]
  let resizeObserver: ResizeObserver | undefined

  function lock(element: HTMLElement | null) {
    if (!element || inertElements.has(element)) return
    inertElements.set(element, element.inert)
    element.inert = true
  }

  function cleanup() {
    abort.abort()
    observer.disconnect()
    resizeObserver?.disconnect()
    document.removeEventListener('scroll', refresh, true)
    window.removeEventListener('keydown', guardKeys, true)
    document.body.classList.remove('shellbeam-tour-active')
    instance?.destroy()
    for (const [element, wasInert] of inertElements) element.inert = wasInert
    inertElements.clear()
    const focusTarget = activeDialog?.isConnected && activeDialog.open
      ? activeDialog.querySelector<HTMLElement>('input, button')
      : previousFocus
    if (focusTarget?.isConnected && !focusTarget.closest('[inert]')) focusTarget.focus({ preventScroll: true })
  }

  function finish(outcome: TourOutcome, notify = true) {
    if (stopped) return
    stopped = true
    cleanup()
    if (notify) options.onFinish(outcome)
  }

  function guardKeys(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      finish('cancelled')
    } else if (instance && (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'Tab' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'
      && (!(event.target instanceof Element) || !event.target.closest('.shellbeam-tour-popover, .shellbeam-tour-loading'))))) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }

  function refresh() { if (!stopped && !busy) instance?.refresh() }

  function foreignDialogOpen() {
    return Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).some((dialog) => dialog !== activeDialog)
  }

  const observer = new MutationObserver(() => {
    if (stopped || busy) return
    if (foreignDialogOpen()) finish('interrupted')
    else if (activeTarget && (!activeTarget.isConnected || !findTourTarget(steps[index].target))) finish('unavailable')
  })

  function attachToDialog(popover?: PopoverDOM) {
    // Native modal dialogs live in the top layer, above any body-level z-index.
    // Move only Driver-owned nodes into that layer; never move application fields.
    const container = activeDialog ?? document.body
    if (popover && popover.wrapper.parentElement !== container) container.appendChild(popover.wrapper)
    overlayElement = document.querySelector('.driver-overlay') ?? overlayElement
    if (overlayElement && overlayElement.parentElement !== container) container.appendChild(overlayElement)
  }

  async function goTo(next: number) {
    if (stopped || busy) return
    if (next >= steps.length) { finish('completed'); return }
    if (next < 0) return
    busy = true
    options.onWaiting(true)
    const step = steps[next]
    if (options.id === 'hosts' && Boolean(step.form) !== formOpen) {
      formOpen = Boolean(step.form)
      options.setHostFormOpen(formOpen)
    }
    const element = await waitForTourTarget(step.target, abort.signal)
    if (stopped) return
    if (!element) { finish('unavailable'); return }
    activeDialog = element.closest<HTMLDialogElement>('dialog[open]')
    if (foreignDialogOpen()) { finish('interrupted'); return }
    activeTarget = element
    index = next
    lock(document.getElementById('root'))
    lock(activeDialog?.querySelector<HTMLElement>('[role="document"]') ?? null)
    resizeObserver?.disconnect()
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(refresh)
      resizeObserver.observe(element)
    }
    const configured = instance!.getConfig().steps!
    configured[next].element = element
    busy = false
    options.onWaiting(false)
    instance!.drive(next)
  }

  async function initialize() {
    busy = true
    options.onWaiting(true)
    window.addEventListener('keydown', guardKeys, true)
    if (document.querySelector('dialog[open]')) { finish('interrupted'); return }
    const root = await waitForTourTarget(TOUR_READY[options.id], abort.signal)
    if (stopped) return
    if (!root) { finish('unavailable'); return }
    // Do not fabricate absent metrics or a desktop-only MCP form on mobile.
    // Only tour optional sections that are actually rendered at launch.
    steps = steps.filter((step) => !step.optional || findTourTarget(step.target))
    const emptyMonitor = options.id === 'monitor' && steps.length === 1
    const limitedMcp = options.id === 'mcp' && steps.length === 1
    const driveSteps: DriveStep[] = steps.map((step, i) => ({
      popover: {
        title: options.t(`tour.${step.key}.title`),
        description: options.t(emptyMonitor ? 'tour.monitorEmpty' : limitedMcp ? 'tour.mcpUnavailable' : `tour.${step.key}.body`),
        side: step.form ? 'right' : 'bottom',
        align: 'start',
      },
      onHighlightStarted: () => { index = i },
    }))
    instance = driver({
      steps: driveSteps,
      animate: false,
      smoothScroll: false,
      disableActiveInteraction: true,
      allowKeyboardControl: true,
      allowClose: true,
      overlayClickBehavior: 'none',
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 10,
      popoverClass: 'shellbeam-tour-popover',
      showProgress: true,
      progressText: '{{current}} / {{total}}',
      nextBtnText: options.t('tour.next'),
      prevBtnText: options.t('tour.previous'),
      doneBtnText: options.t('tour.done'),
      closeBtnLabel: options.t('tour.close'),
      onNextClick: () => { void goTo(index + 1).catch(() => finish('unavailable')) },
      onPrevClick: () => { void goTo(index - 1).catch(() => finish('unavailable')) },
      onCloseClick: () => finish('cancelled'),
      onDestroyed: () => finish('cancelled'),
      onPopoverRender: (popover) => {
        attachToDialog(popover)
        popover.wrapper.setAttribute('aria-modal', 'true')
      },
      onHighlighted: () => attachToDialog(),
    })
    document.body.classList.add('shellbeam-tour-active')
    document.addEventListener('scroll', refresh, true)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'style', 'hidden', 'class'] })
    busy = false
    await goTo(0)
  }

  void initialize().catch(() => finish('unavailable'))
  return {
    cancel: () => finish('cancelled'),
    dispose: () => finish('cancelled', false),
  }
}
