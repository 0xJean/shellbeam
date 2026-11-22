import { webcrypto } from 'node:crypto'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AISettings } from '@/lib/ai'
import { modelCacheKey, saveModelCache } from '@/lib/ai-models'
import { AIModelSwitcher } from './ai-model-switcher'

function ControlledSwitcher({ initial }: { initial: AISettings }) {
  const [settings, setSettings] = useState(initial)
  return <AIModelSwitcher settings={settings} onChange={setSettings} />
}

describe('AIModelSwitcher', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('shellbeam.locale', 'en')
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('auto-discovers models for first-time Ollama and custom endpoints even when no model is selected yet', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:latest' }] }), { status: 200 }),
    )
    render(
      <ControlledSwitcher
        initial={{ ...DEFAULT_AI_SETTINGS, backend: 'api', provider: 'ollama', model: '', apiKey: '' }}
      />,
    )

    fireEvent.click(screen.getByTestId('ai-model-switcher'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'qwen3-coder:latest' })).toBeInTheDocument())

    cleanup()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'internal-ops-70b' }] }), { status: 200 }),
    )
    render(
      <ControlledSwitcher
        initial={{
          ...DEFAULT_AI_SETTINGS,
          backend: 'api',
          provider: 'custom',
          customBaseUrl: 'https://llm.internal.example/v1',
          customModel: '',
          apiKey: '',
        }}
      />,
    )

    fireEvent.click(screen.getByTestId('ai-model-switcher'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'internal-ops-70b' })).toBeInTheDocument())
  })

  it('re-enables Refresh when switching to a freshly cached provider during in-flight automatic discovery', async () => {
    const anthropicSettings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      backend: 'api',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-5-5',
    }
    const anthropicKey = await modelCacheKey(anthropicSettings)
    saveModelCache(anthropicKey, {
      models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      fetchedAt: Date.now(),
    })

    // Hang OpenAI's automatic discovery until aborted.
    vi.mocked(fetch).mockImplementation(
      (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    )

    const initial: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      backend: 'api',
      provider: 'openai',
      apiKey: 'sk-openai-test',
      model: 'gpt-6.2-sol',
      providerProfiles: {
        anthropic: { apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5' },
      },
    }
    render(<ControlledSwitcher initial={initial} />)

    fireEvent.click(screen.getByTestId('ai-model-switcher'))
    // GPT-6.2 Sol exposes Reasoning Effort controls.
    expect(screen.getByRole('button', { name: 'High' })).toBeInTheDocument()

    // Wait for OpenAI background discovery to start.
    const refreshBtn = screen.getByRole('button', { name: 'Refresh models' })
    await waitFor(() => expect(refreshBtn).toBeDisabled())

    // Switch to Anthropic whose cache is fresh -> Refresh must become enabled immediately.
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Anthropic · API' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'claude-opus-5-5' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Refresh models' })).not.toBeDisabled()
  })
})
