import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SegmentedSparkline } from './segmented-sparkline'

describe('SegmentedSparkline', () => {
  it('pads to the requested slot count and preserves segment tones and titles', () => {
    render(
      <SegmentedSparkline
        slots={8}
        label="24h status"
        segments={[
          { key: '1', tone: 'good', ratio: 40, label: '10:00 · 22 ms' },
          { key: '2', tone: 'warn', ratio: 75, label: '11:00 · 140 ms' },
          { key: '3', tone: 'bad', ratio: 100, label: '12:00 · timeout' },
        ]}
      />,
    )

    const root = screen.getByTestId('segmented-sparkline')
    expect(root).toHaveAttribute('aria-label', '24h status')
    const bars = root.querySelectorAll('span')
    expect(bars).toHaveLength(8)
    expect(bars[0]).toHaveAttribute('data-tone', 'unknown')
    expect(bars[5]).toHaveAttribute('data-tone', 'good')
    expect(bars[5]).toHaveAttribute('title', '10:00 · 22 ms')
    expect(bars[6]).toHaveAttribute('data-tone', 'warn')
    expect(bars[7]).toHaveAttribute('data-tone', 'bad')
  })

  it('truncates to the newest segments when input exceeds slot count', () => {
    const segments = Array.from({ length: 30 }, (_, i) => ({
      key: String(i),
      tone: i === 29 ? 'bad' as const : 'good' as const,
      label: `sample-${i}`,
    }))
    render(<SegmentedSparkline slots={24} segments={segments} />)
    const bars = screen.getByTestId('segmented-sparkline').querySelectorAll('span')
    expect(bars).toHaveLength(24)
    expect(bars[0]).toHaveAttribute('title', 'sample-6')
    expect(bars[23]).toHaveAttribute('data-tone', 'bad')
  })
})
