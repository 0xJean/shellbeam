import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelResizeHandle } from '@/components/ui/panel-resize-handle'
import { useResizablePanel } from './use-resizable-panel'

function Harness({
  storageKey = 'testPanel',
  defaultSize = 400,
  minSize = 240,
  maxSize = 700,
  edge = 'left',
}: {
  storageKey?: string
  defaultSize?: number
  minSize?: number
  maxSize?: number
  edge?: 'left' | 'right'
}) {
  const resize = useResizablePanel({ storageKey, defaultSize, minSize, maxSize, edge })
  return (
    <div>
      <PanelResizeHandle testId={`handle-${storageKey}`} label="Resize" dragging={resize.dragging} {...resize.handleProps} />
      <div data-testid={`panel-${storageKey}`} style={{ width: `${resize.size}px` }}>{resize.size}</div>
    </div>
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

const pointerEvent = (type: string, clientX: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX })

describe('useResizablePanel', () => {
  it('drags a left-edged right panel wider and narrower, clamps bounds, persists and restores on remount', () => {
    const first = render(<Harness storageKey="aiAssistant" defaultSize={400} minSize={280} maxSize={640} edge="left" />)
    const handle = screen.getByTestId('handle-aiAssistant')
    expect(screen.getByTestId('panel-aiAssistant')).toHaveStyle({ width: '400px' })

    // Drag left by 120px -> widens right-side panel from 400 to 520
    fireEvent(handle, pointerEvent('pointerdown', 600))
    expect(handle).toHaveAttribute('data-dragging', 'true')
    fireEvent(window, pointerEvent('pointermove', 480))
    expect(screen.getByTestId('panel-aiAssistant')).toHaveStyle({ width: '520px' })
    fireEvent(window, pointerEvent('pointerup', 480))
    expect(handle).toHaveAttribute('data-dragging', 'false')
    expect(localStorage.getItem('shellbeam.panelSize.aiAssistant')).toBe('520')

    // Unmount and remount -> automatically restores saved width
    first.unmount()
    render(<Harness storageKey="aiAssistant" defaultSize={400} minSize={280} maxSize={640} edge="left" />)
    expect(screen.getByTestId('panel-aiAssistant')).toHaveStyle({ width: '520px' })

    // Drag right past minSize -> clamped to 280
    const restoredHandle = screen.getByTestId('handle-aiAssistant')
    fireEvent(restoredHandle, pointerEvent('pointerdown', 500))
    fireEvent(window, pointerEvent('pointermove', 900))
    fireEvent(window, pointerEvent('pointerup', 900))
    expect(screen.getByTestId('panel-aiAssistant')).toHaveStyle({ width: '280px' })
    expect(localStorage.getItem('shellbeam.panelSize.aiAssistant')).toBe('280')

    // Double-click resets to default
    fireEvent.doubleClick(restoredHandle)
    expect(screen.getByTestId('panel-aiAssistant')).toHaveStyle({ width: '400px' })
    expect(localStorage.getItem('shellbeam.panelSize.aiAssistant')).toBe('400')
  })

  it('supports right-edged left panels, keyboard adjustment, and cross-instance sync', () => {
    render(
      <>
        <Harness storageKey="pcNavSidebar" defaultSize={224} minSize={172} maxSize={340} edge="right" />
        <Harness storageKey="pcNavSidebar" defaultSize={224} minSize={172} maxSize={340} edge="right" />
      </>,
    )
    const [handleA] = screen.getAllByTestId('handle-pcNavSidebar')
    const [panelA, panelB] = screen.getAllByTestId('panel-pcNavSidebar')

    // Drag right by 50px -> widens left-side panel to 274 and syncs both mounted instances
    fireEvent(handleA, pointerEvent('pointerdown', 224))
    fireEvent(window, pointerEvent('pointermove', 274))
    fireEvent(window, pointerEvent('pointerup', 274))
    expect(panelA).toHaveStyle({ width: '274px' })
    expect(panelB).toHaveStyle({ width: '274px' })

    // Keyboard ArrowLeft shrinks by 16px
    fireEvent.keyDown(handleA, { key: 'ArrowLeft' })
    expect(panelA).toHaveStyle({ width: '258px' })
    expect(panelB).toHaveStyle({ width: '258px' })
  })
})
